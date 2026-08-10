"""Parse a building plan set into a sqlite/FTS5 index.

Hard-won constraints from the reference sets (see README):
  - NEVER use page.get_text("dict"). Bid Set p60 takes 187-223s in dict mode,
    0.6s in "words" mode. Word bbox height is the font-size proxy.
  - Many pages have text converted to vector outlines: 0 chars, 20k+ paths.
    Those are flagged needs_vision and left to the IDE's vision model.
"""

import contextlib
import fitz
import hashlib
import json
import os
import re
import sqlite3
import sys
import time

# This module backs an MCP server that speaks JSON-RPC over stdout. Anything
# PyMuPDF prints there corrupts the protocol and kills the connection - and it
# does print, e.g. find_tables() recommends the pymupdf_layout package. Send
# every library message to stderr instead.
try:
    fitz.set_messages(stream=sys.stderr)
except Exception:
    pass

# discipline letter -> name. Unknown prefixes pass through so unseen plan sets
# still index instead of erroring.
DISCIPLINES = {
    "G": "General", "GN": "General", "T": "General",
    "C": "Civil", "SP": "Site", "SV": "Survey",
    "L": "Landscape", "A": "Architectural", "AD": "Architectural",
    "ID": "Interiors", "S": "Structural", "E": "Electrical",
    "M": "Mechanical", "P": "Plumbing", "FP": "Fire Protection",
    "FA": "Fire Alarm", "Q": "Equipment", "K": "Kitchen",
}

# Sheet numbering is a convention, not a standard. Accepts the lettered families
# (`A2.2`, `A-101`, `SK-1.01`, `AD101A`) and the purely numeric ones (`101`, `1.01`) that
# the original pattern rejected outright - a rejected number means no discipline, which
# used to mean the sheet fell out of the vision gate entirely.
#
# Numeric-only needs two digits, or a decimal point, so a stray dimension or callout
# bubble does not become a sheet number. `sheet_number` further requires the token to sit
# in the title-block strip and picks the largest one, which is the real filter.
SHEET_RX = re.compile(
    r"^([A-Z]{1,4}-?\d{1,3}(\.\d{1,3}){0,2}[A-Z]?|\d{2,3}(\.\d{1,3})?|\d\.\d{1,3})$")
_PREFIX_RX = re.compile(r"^([A-Z]{1,3})")

# Labels worth pulling out of a title block when the firm uses them. Dutch Bros
# does ("SHEET NUMBER:"), the Bid Set does not - hence the geometric fallback.
TB_LABELS = ("SHEET NAME", "SHEET NUMBER", "SHEET TITLE", "SCALE", "DATE",
             "PROJECT", "CLIENT", "OWNER", "DRAWN", "CHECKED", "JOB", "REV")

# A page that took longer than this to extract is recorded as needing vision rather
# than trusted. This does NOT cap the extraction - it is measured after the call
# returns, so a genuinely pathological page still costs its full wall time once. That is
# tolerable only because "words" mode is the fast path (see the module docstring); if
# extraction ever moves back to a mode that can take minutes, this needs a real timeout,
# not a post-hoc label.
PAGE_BUDGET_S = 20.0
NO_TEXT_CHARS = 50

# Disciplines CBC never estimates. Stated as a DENY list on purpose: an allow list makes
# "Unknown" mean "skip", and 60% of the reference Bid Set has no parseable sheet number, so
# an allow list silently drops 52 of 87 sheets out of the very gate that is supposed to
# catch unread drawings. Only a positively identified out-of-scope discipline is skipped;
# anything unidentified fails toward being looked at.
OUT_OF_SCOPE_DISCIPLINES = (
    "Structural", "Electrical", "Mechanical", "Plumbing", "Civil", "Survey",
    "Landscape", "Fire Protection", "Fire Alarm", "Site",
)

# What a sheet has to mention to be worth a look when it cannot name itself. Deliberately
# CBC's own vocabulary - Division 08, 10 28 and 06 64 - so an unnumbered sheet of rebar
# details is skipped while an unnumbered door schedule is not.
IN_SCOPE_VOCAB_RX = re.compile(
    r"\b(DOORS?|FRAMES?|HOLLOW METAL|\bHM\b|HARDWARE|CLOSERS?|HINGES?|LOCKSETS?|"
    r"THRESHOLDS?|PANIC|EXIT DEVICE|KICK ?PLATES?|LITES?|LOUVERS?|GLAZING|"
    r"GRAB BARS?|DISPENSERS?|MIRRORS?|ACCESSOR|TOILET|RESTROOM|WASHROOM|"
    r"HAND DRYER|NAPKIN|SEAT COVER|COAT HOOK|PARTITIONS?|LOCKERS?|"
    r"FIRE EXTINGUISHER|FRP|FIBERGLASS|WALL PANELS?|MOULDING|MOLDING|"
    r"FINISH SCHEDULE|ROOM SCHEDULE|WALL TYPES?)\b", re.I)

# Sheets whose meaning is geometry, not prose. A floor plan's fixture count, an
# elevation's tag callouts and a CAD schedule's column-to-row association all live in
# the drawing; the text layer flattens them into an order that cannot be trusted. These
# need a vision pass even when the page extracts perfectly.
#
# Measured on Dutch Bros 11-21-25: accessory schedule A1.2 carries no quantity and no
# size ("SIZE DEPENDANT ON INSTALLATION LOCATION"), and the counts exist only as tags on
# elevation A5.1. Reading text alone, the estimate invented both.
DRAWING_TITLE_RX = re.compile(
    r"\b(PLAN|ELEVATION|SECTION|DETAIL|SCHEDULE|PARTITION|LAYOUT|CEILING|ROOF|"
    r"CANOPY|AWNING|ENCLOSURE|FINISH|EQUIPMENT)S?\b|\b(ENLARGED|REFLECTED)\b", re.I)

# Prose sheets. Specifications and general notes are paragraphs - the text layer is the
# whole content, and rendering them buys nothing.
PROSE_TITLE_RX = re.compile(
    r"\b(SPECIFICATION|ABBREVIATION|LEGEND|SYMBOL|GENERAL NOTE|CODE|INDEX)S?\b|"
    r"\b(ACCESSIBILITY DETAILS|COVER SHEET)\b", re.I)

# A title block value that is plainly not a title: a bare dimension picked out of a
# drawing annotation, or the copyright line. Dutch Bros stored A6.0 as `3' - 2"`,
# A7.1 as `-0' - 6"` and S2.1 as `c 2025 DB Franchising USA, LLC`.
NOT_A_TITLE_RX = re.compile(
    r"^\s*(-?\d+'\s*-?\s*\d*\s*\d*/?\d*\"?|[\d.]+|c?\s*©?\s*\d{4}\s+.*LLC\.?)\s*$",
    re.I)


# What to search for when looking for a schedule of a given kind. Location is never the
# key - the door schedule is on A2.2 in one set and page 31 of the next - so discovery
# goes through the FTS index by vocabulary. Seeded from the term lists the
# specialties-takeoff skill already carries; that skill is the model, because Division 10
# is frequently keynotes on an enlarged restroom plan rather than a schedule at all.
SCHEDULE_VOCAB = {
    "door": ["door schedule", "door type", "door and frame", "opening schedule",
             "door no", "door mark", "frame type"],
    "hardware": ["hardware group", "hardware set", "hardware schedule", "finish hardware",
                 "door hardware", "hw group", "hw set"],
    "accessory": ["toilet accessor", "bath accessor", "washroom accessor", "grab bar",
                  "dispenser", "mirror", "hand dryer", "napkin", "seat cover",
                  "coat hook", "baby chang", "accessory schedule"],
    "finish": ["finish schedule", "room finish", "wall finish", "frp", "wall panel",
               "fiberglass reinforced", "material legend"],
    "window": ["window schedule", "glazing schedule", "storefront", "window type"],
    "room": ["room schedule", "room finish schedule", "occupancy"],
    "equipment": ["equipment schedule", "equipment plan", "fixture schedule"],
    "partition": ["partition type", "wall type", "wall assembly", "partition schedule"],
}


def is_not_a_title(text):
    """True when a title-block candidate is a dimension, a bare number or a copyright."""
    if not text:
        return True
    return bool(NOT_A_TITLE_RX.match(text.strip()))


def vision_role(sheet_no, title, body=""):
    """Why this sheet does or does not need a visual read.

    Returns "drawing" or "prose". Role is about the sheet's CONTENT, and is deliberately
    independent of whether the text layer extracted - a page can extract perfectly and
    still be unreadable, because what it means is drawn rather than written.

    `body` is the fallback identity. A sheet whose number does not parse has no discipline
    and no title, so the only thing left to judge it on is what it says: an unnumbered
    door schedule reads as a drawing, an unnumbered rebar detail does not.
    """
    if discipline_of(sheet_no) in OUT_OF_SCOPE_DISCIPLINES:
        return "prose"
    t = title or ""
    if PROSE_TITLE_RX.search(t):
        return "prose"
    if DRAWING_TITLE_RX.search(t):
        return "drawing"
    # No usable identity: judge by content rather than assuming harmless.
    if not sheet_no and not t:
        return "drawing" if IN_SCOPE_VOCAB_RX.search(body or "") else "prose"
    # A sheet we cannot name is not assumed harmless. Dutch Bros A6.0/A7.0/A7.1 are
    # building elevations whose titles came through as dimension strings.
    return "drawing"

# How often index_doc checkpoints, so a reader on the WAL sees the index fill in.
COMMIT_EVERY_PAGES = 25


def discipline_of(sheet_no):
    if not sheet_no:
        return "Unknown"
    m = _PREFIX_RX.match(sheet_no)
    if not m:
        return "Unknown"
    p = m.group(1)
    # try longest prefix first: SP before S, FP before F
    return DISCIPLINES.get(p) or DISCIPLINES.get(p[0]) or p


def _words(page):
    """Word tuples, always 'words' mode. Never 'dict' - see module docstring."""
    return page.get_text("words")


def sheet_number(page, words=None):
    """Largest sheet-number-shaped token in the title block strip.

    Title blocks sit on the right edge (landscape) or bottom (portrait). Word
    bbox height stands in for font size; rotated text is measured on its wide
    axis instead.
    """
    words = _words(page) if words is None else words
    W, H = page.rect.width, page.rect.height
    best = None
    for x0, y0, x1, y1, txt, *_ in words:
        t = txt.strip()
        if not SHEET_RX.match(t):
            continue
        if not (x0 > W * 0.85 or y0 > H * 0.85):
            continue
        h = y1 - y0
        if h < 3:  # rotated 90deg: the glyph height is the x extent
            h = x1 - x0
        if best is None or h > best[1]:
            best = (t, h)
    return best[0] if best else None


def title_block(page, words=None):
    """Right-strip rows, plus label:value pairs where the firm uses labels.

    A label's value is the next row *starting at the same x*. Drawing
    annotations bleed into the strip (Dutch Bros A2.0 has a stray "SIM.)"
    sitting between "SHEET NAME:" and "FLOOR PLAN"), and they are only
    distinguishable by being out of the title block's left alignment.
    """
    words = _words(page) if words is None else words
    W, H = page.rect.width, page.rect.height
    # Right strip first, and the bottom strip when the right one is empty. `sheet_number`
    # already accepts either edge; this only looked right, so a portrait sheet with a
    # bottom title block got its number and never its title.
    strip = [w for w in words if w[0] > W * 0.85]
    if len(strip) < 4:
        strip = [w for w in words if w[1] > H * 0.85]
    strip.sort(key=lambda w: (round(w[1] / 6), w[0]))

    rows, cur, key = [], [], None  # rows of (x0, text)
    for w in strip:
        k = round(w[1] / 6)
        if k != key:
            if cur:
                rows.append((cur[0][0], " ".join(t for _, t in cur)))
            cur, key = [], k
        cur.append((w[0], w[4]))
    if cur:
        rows.append((cur[0][0], " ".join(t for _, t in cur)))

    tol = W * 0.04
    labels_up = {l + ":" for l in TB_LABELS} | set(TB_LABELS)
    fields = {}
    for i, (x0, row) in enumerate(rows):
        up = row.upper().strip()
        for lab in TB_LABELS:
            if up in (lab, lab + ":"):
                for vx, nxt in rows[i + 1:]:
                    if not nxt.strip() or nxt.upper().strip() in labels_up:
                        continue
                    if abs(vx - x0) <= tol:
                        fields[lab.title()] = nxt.strip()
                        break
                break
            if up.startswith(lab) and ":" in row and len(up) > len(lab) + 1:
                fields.setdefault(lab.title(), row.split(":", 1)[-1].strip())
    return {"fields": fields, "rows": [r for _, r in rows if r.strip()]}


def _bookmark_sheets(doc):
    """{page -> (sheet_no, title)} from PDF outline. Skips page -1 entries:
    9 of Dutch Bros' 58 bookmarks have broken destinations."""
    out = {}
    for _lvl, title, pg in doc.get_toc():
        if pg is None or pg < 1:
            continue
        # Three shapes seen in the wild: `A2.2 - DOOR SCHEDULE`, `A2.2 DOOR SCHEDULE`
        # (no separator) and `DOOR SCHEDULE (A2.2)`. Only the first used to be accepted,
        # so the other two lost the bookmark fallback entirely.
        num = r"[A-Z]{1,4}-?\d{1,3}(?:\.\d{1,3}){0,2}[A-Z]?"
        m = (re.match(rf"^\s*({num})\s*[-–:]\s*(.+)$", title)
             or re.match(rf"^\s*({num})\s+(\D.*)$", title))
        if m:
            out[pg] = (m.group(1), m.group(2).strip())
            continue
        m = re.match(rf"^\s*(.+?)\s*[\(\[]\s*({num})\s*[\)\]]\s*$", title)
        if m:
            out[pg] = (m.group(2), m.group(1).strip())
    return out


def _cover_index(doc):
    """{sheet_no -> title} scraped from a drawing index on the first pages.

    Eight rather than three: a drawing index often sits on `G0.2` or later, behind a cover,
    a code-summary sheet and an accessibility sheet. Rows already have to look like
    `<sheet_no> <title>` to be kept, so widening the window costs a few word extractions
    and cannot introduce junk.
    """
    out = {}
    for pno in range(min(8, len(doc))):
        try:
            words = _words(doc[pno])
        except Exception:
            continue
        rows, cur, key = [], [], None
        for w in sorted(words, key=lambda w: (round(w[1] / 5), w[0])):
            k = round(w[1] / 5)
            if k != key:
                if cur:
                    rows.append(cur)
                cur, key = [], k
            cur.append(w[4])
        if cur:
            rows.append(cur)
        for row in rows:
            if len(row) < 2:
                continue
            head = row[0].strip()
            if SHEET_RX.match(head) and len(row) > 1:
                title = " ".join(row[1:]).strip(" -–")
                if 3 < len(title) < 120:
                    out.setdefault(head, title)
    return out


SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
  doc_id TEXT PRIMARY KEY, path TEXT, pages INT, indexed_at REAL, stamp TEXT
);
CREATE TABLE IF NOT EXISTS sheets (
  doc_id TEXT, page INT, sheet_no TEXT, title TEXT, discipline TEXT,
  confidence TEXT, vision_need TEXT, width_in REAL, height_in REAL, tb_json TEXT,
  vision_status TEXT DEFAULT 'required',
  PRIMARY KEY (doc_id, page)
);
CREATE VIRTUAL TABLE IF NOT EXISTS sheet_text USING fts5(
  doc_id UNINDEXED, page UNINDEXED, source UNINDEXED, body
);
"""


def db_path():
    base = os.environ.get("BPI_CACHE") or os.path.join(
        os.path.expanduser("~"), ".cache", "building-plan-intelligence")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "index.db")


def connect():
    con = sqlite3.connect(db_path())
    # WAL so a long indexing write does not block readers. The frontend opens this same
    # file read-only; under the default rollback journal it got SQLITE_BUSY for the
    # duration of an index and rendered the sheet list as empty.
    try:
        con.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        pass          # read-only media or a filesystem without shared-memory support
    con.executescript(SCHEMA)
    # An index built before vision_status existed keeps its rows. Default the column to
    # 'required' so a pre-existing sheet reads as unverified rather than silently cleared -
    # the whole point of the column is that "nobody looked" must not look like "looked, fine".
    try:
        con.execute("ALTER TABLE sheets ADD COLUMN vision_status TEXT DEFAULT 'required'")
    except sqlite3.OperationalError:
        pass          # already present
    return con


def _stamp(path):
    st = os.stat(path)
    return f"{st.st_mtime_ns}:{st.st_size}"


# Bump whenever indexing logic changes what a row would contain. The cache is keyed on the
# FILE, so without this a plan set indexed under older logic keeps its old verdict forever -
# an unchanged PDF never re-indexes. Bumped to 2 when vision_need started being decided by
# what a sheet contains rather than whether its text extracted.
INDEX_VERSION = 3


def _index_stamp(path):
    """Cache key for the `docs` row: the file, plus the logic that read it."""
    return f"{_stamp(path)}:v{INDEX_VERSION}"


def doc_id_for(path):
    # Deliberately NOT versioned: doc_ids are quoted in estimates and written into
    # memory/active_project.json, so they must survive an indexer change.
    p = os.path.abspath(path)
    return hashlib.sha1(f"{p}:{_stamp(p)}".encode()).hexdigest()[:16]


def index_doc(path, con=None, force=False):
    """Index a plan set. Cached by path+mtime+size; re-indexing is a no-op."""
    path = os.path.abspath(path)
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    own = con is None
    con = con or connect()
    doc_id = doc_id_for(path)
    stamp = _index_stamp(path)

    row = con.execute("SELECT stamp FROM docs WHERE doc_id=?", (doc_id,)).fetchone()
    if row and row[0] == stamp and not force:
        return doc_id, False

    doc = fitz.open(path)
    bookmarks = _bookmark_sheets(doc)
    cover = _cover_index(doc)

    con.execute("DELETE FROM sheets WHERE doc_id=?", (doc_id,))
    con.execute("DELETE FROM sheet_text WHERE doc_id=?", (doc_id,))

    for pno in range(len(doc)):
        page = doc[pno]
        t0 = time.time()
        try:
            words = _words(page)
            # Index reading-order rows, not raw get_text(): raw output interleaves
            # unrelated columns, so terms that sit side by side on the sheet end up
            # far apart in the string and verbatim verification misses them.
            body = "\n".join(layout_rows(page, words=words)) if words else ""
        except Exception:
            words, body = [], ""
        slow = (time.time() - t0) > PAGE_BUDGET_S

        sn = tb = None
        if words and not slow:
            sn = sheet_number(page, words)
            tb = title_block(page, words)

        conf = "title_block"
        title = (tb or {}).get("fields", {}).get("Sheet Name")
        # A dimension string is not a sheet name. Drop it rather than storing it, so the
        # bookmark and cover-index fallbacks below get their turn. `conf` is the sheet
        # NUMBER's confidence and is deliberately left alone.
        if is_not_a_title(title):
            title = None
        bm = bookmarks.get(pno + 1)
        if not sn and bm:
            sn, conf = bm[0], "bookmark"
        if not title and bm and (sn == bm[0] or conf == "bookmark"):
            title = bm[1]
        if sn and not title:
            title = cover.get(sn)
        if not sn:
            conf = "none"

        # Three independent gaps. Two are extraction failures, measured on the Bid Set:
        # 24 pages have no body text at all ("full"), and another 30 have live body text
        # but a title block outlined to vectors ("identity" - searchable, cannot name
        # itself). The third is not a failure at all: an in-scope sheet whose content is
        # geometry needs a visual read however cleanly it extracted, because quantities,
        # sizes and tag counts are drawn rather than written.
        # Four verdicts, because they call for different remedies and must not be
        # conflated. Order matters: a page with no text needs the most help, and a page
        # that cannot name itself needs identifying before anything else is worth doing.
        #   full     - no text layer at all; nothing is searchable
        #   identity - searchable, but the title block was outlined so it is unnamed
        #   drawing  - extracted and named, but its meaning is geometry (counts, tags,
        #              dimensions) which the text layer cannot carry
        #   none     - prose; the text layer is the whole content
        role = vision_role(sn, title, body)
        if slow or len(body.strip()) < NO_TEXT_CHARS:
            vision_need = "full"
        elif not sn:
            vision_need = "identity"
        elif role == "drawing":
            vision_need = "drawing"
        else:
            vision_need = "none"
        vision_status = "not_required" if vision_need == "none" else "required"

        r = page.rect
        con.execute(
            "INSERT OR REPLACE INTO sheets VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (doc_id, pno + 1, sn, title, discipline_of(sn), conf, vision_need,
             round(r.width / 72, 2), round(r.height / 72, 2),
             json.dumps(tb or {}), vision_status))
        if body.strip():
            con.execute(
                "INSERT INTO sheet_text (doc_id,page,source,body) VALUES (?,?,?,?)",
                (doc_id, pno + 1, "pdf", body))

        # Checkpoint in chunks rather than holding one transaction across the whole set.
        # The `docs` row lands last, so a crash mid-index leaves rows under a doc_id no
        # query resolves, and re-indexing replaces them.
        if pno % COMMIT_EVERY_PAGES == COMMIT_EVERY_PAGES - 1:
            con.commit()

    con.execute("INSERT OR REPLACE INTO docs VALUES (?,?,?,?,?)",
                (doc_id, path, len(doc), time.time(), stamp))
    con.commit()
    doc.close()
    if own:
        con.close()
    return doc_id, True


def layout_rows(page, clip=None, row_tol=4.0, gap=30.0, words=None):
    """Text as spatially-ordered rows, with column gaps marked.

    `get_text("text")` on a CAD sheet interleaves columns from unrelated tables
    into unreadable soup - that is how a reader ends up pairing a value with the
    wrong row. Grouping by y and marking large x-gaps keeps columns apart.

    Takes `words` for the same reason `sheet_number` and `title_block` do: the caller
    usually has them already, and re-extracting doubled the cost of indexing a page.
    """
    words = _words(page) if words is None else words
    if clip is not None:
        words = [w for w in words
                 if clip.x0 <= w[0] <= clip.x1 and clip.y0 <= w[1] <= clip.y1]
    buckets = {}
    for w in words:
        buckets.setdefault(round(w[1] / row_tol), []).append(w)
    out = []
    for k in sorted(buckets):
        ws = sorted(buckets[k], key=lambda w: w[0])
        parts, prev_x1 = [], None
        for w in ws:
            if prev_x1 is not None and w[0] - prev_x1 > gap:
                parts.append("  |  ")
            parts.append(w[4])
            prev_x1 = w[2]
        line = " ".join(parts).replace(" |   ", "  |  ")
        if line.strip():
            out.append(line)
    return out


def page_tables(page, clip=None, max_tables=40):
    """Ruled tables as real rows via PyMuPDF's table finder.

    Schedules on plan sheets are drawn as ruled vector grids, and the finder
    recovers them cleanly - door schedules, hardware groups, equipment
    schedules. This is the only reliable way to read a schedule row-wise.
    """
    try:
        # belt and braces: never let a stray print reach the JSON-RPC channel
        with contextlib.redirect_stdout(sys.stderr):
            found = page.find_tables(clip=clip) if clip is not None else page.find_tables()
    except Exception:
        return []
    out = []
    for tb in found.tables[:max_tables]:
        try:
            rows = []
            for r in tb.extract():
                cells = [(c or "").strip() for c in r]
                if any(cells):
                    rows.append(cells)
            if rows:
                out.append({"bbox": [round(v, 1) for v in tb.bbox], "rows": rows})
        except Exception:
            continue
    return out


_WS = re.compile(r"\s+")
# Quote styles, the column markers layout_rows inserts, and separators that vary
# freely between how a drawing writes a value and how someone quotes it back
# ('Trifab VG 451T' vs "Trifab VG 451T", '99EO, 26"' vs '99EO 26'). Stripping
# them avoids rejecting a claim that is genuinely in the document.
_STRIP = re.compile(r"[‘’“”″′\"'`|,]")


def norm(s):
    """Normalize for verbatim comparison: case, quotes, separators, whitespace."""
    return _WS.sub(" ", _STRIP.sub(" ", s or "")).strip().upper()


# Normalized sheet bodies, keyed by doc_id. verify_facts is documented as the thing to
# run on every claim before answering, so it is the hottest tool here, and it used to
# re-normalize the whole set - two regex passes over every sheet - on every call.
# Caching needs no invalidation hook: doc_id is a hash of path + mtime + size, so a
# re-indexed set is simply a different key.
#
# NOT narrowed through FTS: verify_facts matches substrings, while FTS matches whole
# tokens, so an FTS prefilter drops real hits (a claim that is part of a longer word).
# The scan stays exhaustive; only the normalization is cached.
_NORM_CACHE = {}
_NORM_CACHE_MAX = 3


def normalized_sheets(con, doc_id):
    """[(page, source, normalized body)] for a document, normalized at most once."""
    cached = _NORM_CACHE.get(doc_id)
    if cached is None:
        cached = [(p, src, norm(b)) for p, src, b in con.execute(
            "SELECT page, source, body FROM sheet_text WHERE doc_id=?", (doc_id,))]
        if len(_NORM_CACHE) >= _NORM_CACHE_MAX:
            _NORM_CACHE.pop(next(iter(_NORM_CACHE)))
        _NORM_CACHE[doc_id] = cached
    return cached


def _squash(s):
    """`A-2.02` and `A202` and `a 2.02` all collapse to the same key."""
    return re.sub(r"[^A-Z0-9]", "", str(s or "").upper())


def resolve_page(con, doc_id, sheet):
    """Accept a sheet number ('A2.0') or a page number ('13').

    Degrades rather than failing. Numbering differs between firms - `A2.2` in one set is
    `A-202` in the next - so an exact-match-only lookup turned every convention mismatch
    into a hard error with nothing to try next.
    """
    s = str(sheet).strip()
    row = con.execute(
        "SELECT page FROM sheets WHERE doc_id=? AND UPPER(sheet_no)=?",
        (doc_id, s.upper())).fetchone()
    if row:
        return row[0]
    if s.isdigit():
        row = con.execute("SELECT page FROM sheets WHERE doc_id=? AND page=?",
                          (doc_id, int(s))).fetchone()
        if row:
            return row[0]
    # Punctuation-insensitive match: A-202 <-> A202 <-> a.202
    key = _squash(s)
    if key:
        for page, sn in con.execute(
                "SELECT page, sheet_no FROM sheets WHERE doc_id=? AND sheet_no IS NOT NULL",
                (doc_id,)):
            if _squash(sn) == key:
                return page
    return None


def near_misses(con, doc_id, sheet, limit=8):
    """Sheet numbers that look like the one asked for, for an actionable error.

    A caller that guessed the wrong convention needs to see the set's own numbering, not
    just "not found" - that is the difference between recovering and retrying the guess.
    """
    key = _squash(sheet)
    rows = con.execute(
        "SELECT sheet_no, title, page FROM sheets WHERE doc_id=? AND sheet_no IS NOT NULL "
        "ORDER BY page", (doc_id,)).fetchall()
    if not rows:
        return []
    stem = re.match(r"^[A-Z]+|^\d+", key)
    stem = stem.group(0) if stem else key[:1]
    scored = [r for r in rows if _squash(r[0]).startswith(stem)] or rows
    return [{"sheet": r[0], "title": r[1], "page": r[2]} for r in scored[:limit]]
