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

SHEET_RX = re.compile(r"^[A-Z]{1,3}-?\d{1,3}(\.\d{1,3})?[A-Z]?$")
_PREFIX_RX = re.compile(r"^([A-Z]{1,3})")

# Labels worth pulling out of a title block when the firm uses them. Dutch Bros
# does ("SHEET NUMBER:"), the Bid Set does not - hence the geometric fallback.
TB_LABELS = ("SHEET NAME", "SHEET NUMBER", "SHEET TITLE", "SCALE", "DATE",
             "PROJECT", "CLIENT", "OWNER", "DRAWN", "CHECKED", "JOB", "REV")

# A page that takes longer than this to extract is treated as unreadable rather
# than allowed to hang the server.
PAGE_BUDGET_S = 20.0
NO_TEXT_CHARS = 50


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
    W = page.rect.width
    strip = [w for w in words if w[0] > W * 0.85]
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
        m = re.match(r"^\s*([A-Z]{1,3}-?\d{1,3}(?:\.\d{1,3})?[A-Z]?)\s*[-–]\s*(.+)$", title)
        if m:
            out[pg] = (m.group(1), m.group(2).strip())
    return out


def _cover_index(doc):
    """{sheet_no -> title} scraped from a drawing index on the first pages."""
    out = {}
    for pno in range(min(3, len(doc))):
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
    con.executescript(SCHEMA)
    return con


def _stamp(path):
    st = os.stat(path)
    return f"{st.st_mtime_ns}:{st.st_size}"


def doc_id_for(path):
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
    stamp = _stamp(path)

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
            body = "\n".join(layout_rows(page)) if words else ""
        except Exception:
            words, body = [], ""
        slow = (time.time() - t0) > PAGE_BUDGET_S

        sn = tb = None
        if words and not slow:
            sn = sheet_number(page, words)
            tb = title_block(page, words)

        conf = "title_block"
        title = (tb or {}).get("fields", {}).get("Sheet Name")
        bm = bookmarks.get(pno + 1)
        if not sn and bm:
            sn, conf = bm[0], "bookmark"
        if not title and bm and (sn == bm[0] or conf == "bookmark"):
            title = bm[1]
        if sn and not title:
            title = cover.get(sn)
        if not sn:
            conf = "none"

        # Two independent gaps, measured on the Bid Set: 24 pages have no body
        # text at all ("full"), and another 30 have live body text but a title
        # block that was outlined to vectors ("identity" - the sheet is
        # searchable but cannot name itself).
        if slow or len(body.strip()) < NO_TEXT_CHARS:
            vision_need = "full"
        elif not sn:
            vision_need = "identity"
        else:
            vision_need = "none"

        r = page.rect
        con.execute(
            "INSERT OR REPLACE INTO sheets VALUES (?,?,?,?,?,?,?,?,?,?)",
            (doc_id, pno + 1, sn, title, discipline_of(sn), conf, vision_need,
             round(r.width / 72, 2), round(r.height / 72, 2),
             json.dumps(tb or {})))
        if body.strip():
            con.execute(
                "INSERT INTO sheet_text (doc_id,page,source,body) VALUES (?,?,?,?)",
                (doc_id, pno + 1, "pdf", body))

    con.execute("INSERT OR REPLACE INTO docs VALUES (?,?,?,?,?)",
                (doc_id, path, len(doc), time.time(), stamp))
    con.commit()
    doc.close()
    if own:
        con.close()
    return doc_id, True


def layout_rows(page, clip=None, row_tol=4.0, gap=30.0):
    """Text as spatially-ordered rows, with column gaps marked.

    `get_text("text")` on a CAD sheet interleaves columns from unrelated tables
    into unreadable soup - that is how a reader ends up pairing a value with the
    wrong row. Grouping by y and marking large x-gaps keeps columns apart.
    """
    words = _words(page)
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


def resolve_page(con, doc_id, sheet):
    """Accept a sheet number ('A2.0') or a page number ('13')."""
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
    return None
