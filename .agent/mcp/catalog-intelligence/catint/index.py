"""Parse a vendor price book / product catalog into a sqlite+FTS5 index.

Measured on Hager Price Book #18 (744pp), which is the shape this targets:
  - Every page has a text layer, so no vision pass is needed (unlike plan sets).
  - Price rows are NOT ruled tables. find_tables() returns only the header row;
    the 4000+ price lines under it are invisible to it. They are recovered by
    assigning words to columns using the header labels' x positions.
  - A product's description and size are vertically CENTERED against the block
    of finish/price rows they own, so neither can be read by carry-forward from
    the row above. Rows are grouped first (a new group starts wherever a
    box/case quantity appears), then description and size are matched to the
    group whose y-span contains them.

NEVER use page.get_text("dict") here - "words" mode is ~50x faster and carries
the bbox needed for column assignment.
"""

import hashlib
import os
import re
import sqlite3
import sys
import time
from collections import defaultdict

import fitz

# This module backs an MCP server speaking JSON-RPC over stdout. Anything
# PyMuPDF prints there corrupts the protocol and drops the connection.
try:
    fitz.set_messages(stream=sys.stderr)
except Exception:
    pass

# ---------------------------------------------------------------- CSI mapping

# Product-level, not section-level: a door-hardware book is Division 08 almost
# everywhere, but its "Trim & Auxiliary" section still carries coat hooks
# (10 28 00) and corner guards (10 26 00). Tagging by section alone would
# answer a Division 10 question with "nothing here", which is wrong.
# Rules are ordered - first match wins, so put the specific ones first.
DIV_RULES = [
    (r"toilet\s+partition|toilet\s+compartment|urinal\s+screen|\bpilasters?\b"
     r"|head\s*rails?|compartment\s+door", "10 21 13", "Toilet Compartments"),
    (r"shower\s+(?:curtains?|rods?|seats?|doors?)|\bdressing\s+(?:room|booth)",
     "10 28 13", "Bath and Shower Accessories"),
    (r"grab\s*bars?|toilet\s+accessor|paper\s+holders?|soap\s+dish"
     r"|robe\s+hooks?|coat\s+hooks?|garment\s+hooks?|hat\s+and\s+coat"
     r"|mop\s*(?:/|\s|and\s)*broom|towel\s+bars?"
     # the vocabulary of a washroom-accessory price list (ASI, Bobrick,
     # Bradley, World Dryer). Without these their whole catalogs classify as
     # unknown and a Division 10 question comes back empty.
     r"|baby\s+chang|diaper\s+chang|dispens|\bdisp\.|napkin\s+(?:disposal|vendor)"
     r"|sanitary\s+(?:napkin|disposal)|waste\s+(?:receptacle|disposal|unit)"
     r"|towel\s*/\s*waste|\btrash\s+receptacle"
     r"|hand\s+dr(?:yer|ier)|\bmirrors?\b|towel\s+(?:pin|ring)|\btumbler\b"
     r"|toilet\s+tissue|seat\s+cover|utility\s+shelf|purse\s+shelf|soap\s+dispens",
     "10 28 00", "Toilet, Bath, and Laundry Accessories"),
    (r"corner\s+guards?|wall\s+guards?|crash\s+rails?", "10 26 00", "Wall and Door Protection"),
    (r"fire\s+extinguisher",                    "10 44 00", "Fire Protection Specialties"),
    (r"\blockers?\b",                           "10 51 00", "Lockers"),
    (r"mail\s*box|mail\s+slot",                 "10 55 00", "Postal Specialties"),
    (r"flag\s*poles?",                          "10 75 00", "Flagpoles"),
    (r"\bsignage\b|sign\s+plates?|room\s+signs?|\bada\s+tactile", "10 14 00", "Signage"),
    (r"\bdirectory\b|bulletin\s+boards?|visual\s+display", "10 11 00", "Visual Display Units"),
    # Division 22 - washroom vendors sell the fixtures next to the accessories.
    (r"\bfaucets?\b|soap\s+valve|flush\s*(?:o)?meter|\bwater\s+closet\b",
     "22 42 00", "Commercial Plumbing Fixtures"),
    # Division 06 / 09 - wall panelling sold alongside washroom specialties.
    (r"\bfrp\b|fiberglass\s+reinforced|vinyl\s+moulding|vinyl\s+molding"
     r"|wall\s+panel", "06 64 00", "Plastic Paneling"),
    # Division 08 - the bulk of a door-hardware book.
    (r"power\s+operators?|automatic\s+door\s+open|low\s+energy",
     "08 71 13", "Automatic Door Operators"),
    (r"\blouvers?\b|\bvision\s+lite|\blite\s+kits?\b|\bglazing\s+bead",
     "08 91 00", "Louvers and Vents"),
    (r"thresholds?|weatherstrip|door\s+sweeps?|gasketing|astragals?|rain\s+drip",
     "08 71 00", "Door Hardware"),
    (r"\bhinges?\b|\bpivots?\b",                "08 71 00", "Door Hardware"),
    (r"exit\s+devices?|\bpanic\b|fire\s+exit",  "08 71 00", "Door Hardware"),
    (r"\bclosers?\b|door\s+controls?|door\s+holders?|overhead\s+stops?",
     "08 71 00", "Door Hardware"),
    (r"\blocks?\b|locksets?|cylinders?|deadbolts?|\blatch|strikes?\b|\bkeys?\b|exit\s+trim",
     "08 71 00", "Door Hardware"),
    (r"kick\s*plates?|armor\s*plates?|mop\s*plates?|push\s*(?:plates?|bars?)|\bpulls?\b"
     r"|door\s+stops?|floor\s+stops?|wall\s+stops?|silencers?|flush\s+bolts?"
     r"|door\s+guards?|\bcatch(?:es)?\b|\bprotection\s+plates?",
     "08 71 00", "Door Hardware"),
    (r"sliding\s+door|barn\s+door|pocket\s+door", "08 71 00", "Door Hardware"),
    (r"electric\s+strikes?|electrified|magnetic\s+locks?|maglock"
     r"|power\s+(?:supply|transfer)|door\s+position\s+switch",
     "08 71 00", "Door Hardware"),
]
DIV_RX = [(re.compile(rx, re.I), d, n) for rx, d, n in DIV_RULES]

DIVISION_NAMES = {
    "06": "Wood, Plastics, and Composites",
    "07": "Thermal and Moisture Protection",
    "08": "Openings", "09": "Finishes", "10": "Specialties",
    "22": "Plumbing",
}


def classify(text):
    """(division, csi_section, csi_name) for a product blurb, or (None,)*3."""
    for rx, sec, name in DIV_RX:
        if rx.search(text or ""):
            return sec.split()[0], sec, name
    return None, None, None


# ---------------------------------------------------------------- page parsing

# Column labels that mark the start of a price table. Enough of them on one
# line is what distinguishes a price page from a marketing page.
HDR_LABELS = {"description", "size", "finish", "list", "qty", "code", "item",
              "number", "name", "product", "price", "part", "each", "length"}
MODEL_RX = re.compile(r"^[A-Z]{0,4}\d{2,5}[A-Z0-9./-]*$")
PRICE_RX = re.compile(r"^\$?\d{1,3}(?:,\d{3})*\.\d{2}$")
PRICE_ANY = re.compile(r"\$?\b\d{1,3}(?:,\d{3})*\.\d{2}\b")
ITEMNO_RX = re.compile(r"^\d{5,9}$")
DATE_RX = re.compile(r"Effective\s+(\d{1,2}/\d{1,2}/\d{2,4})", re.I)
DOMAIN_RX = re.compile(r"www\.([a-z0-9-]+)\.com", re.I)
MULT_RX = re.compile(r"(\d*\.\d{2,3})\s*multiplier", re.I)

ROW_TOL = 3.5  # y bucket, in points; price lines sit ~15pt apart
# A size wraps onto 2-3 lines ('4-1/2" x 4-1/2"' / '(114 mm x 114 mm)') ~11pt
# apart, while two different sizes are a whole price group apart (~100pt).
# ponytail: one gap constant, no clustering. Widen it if a catalog stacks its
# size groups more tightly than this.
SIZE_LINE_GAP = 18.0


def _bands(words, tol=ROW_TOL):
    """Words grouped into visual rows, top to bottom, left to right in a row."""
    b = defaultdict(list)
    for w in words:
        b[round(w[1] / tol)].append(w)
    return [sorted(b[k], key=lambda w: w[0]) for k in sorted(b)]


def section_of(page):
    """Running head, e.g. 'Locks - 3800 Series' -> ('Locks', '3800 Series')."""
    top = [w for w in page.get_text("words") if w[1] < 45]
    top.sort(key=lambda w: (round(w[1] / 4), w[0]))
    head = " ".join(w[4] for w in top).strip()
    # some pages stamp the head twice, interleaved: 'Trim Trim & & Auxiliary Auxiliary'
    toks = head.split()
    if len(toks) > 1 and toks[::2] == toks[1::2]:
        head = " ".join(toks[::2])
    if " - " in head:
        a, b = head.split(" - ", 1)
        return a.strip(), b.strip()
    return head, ""


def catalog_page_no(page):
    """The page number the book prints on itself - what a person would cite."""
    for w in page.get_text("words"):
        if 40 < w[1] < 72 and w[0] < 140 and w[4].strip().isdigit():
            return w[4].strip()
    return None


def _header_row(bands):
    """Index, y and label words of the column-header row, if the page has one.

    Three labels is enough when one of them is the price column - the Locks
    section rules only 'Description | Finish | List'. Any looser and prose
    pages start looking like tables.
    """
    for i, r in enumerate(bands):
        labs, seen = [], []
        for w in r:
            name = w[4].strip().lower().strip(".:")
            if name not in HDR_LABELS:
                continue
            c = (w[0] + w[2]) / 2
            # some pages stamp the header twice, one copy a hair off the other
            if any(abs(c - o) < 3 for o in seen):
                continue
            seen.append(c)
            labs.append(w)
        names = {w[4].strip().lower().strip(".:") for w in labs}
        if len(labs) >= 4 or (len(labs) >= 3 and names & {"list", "price"}):
            return i, r[0][1], labs
    return None, None, None


def _columns(labels):
    """Header labels -> [(x_lo, x_hi, name)] covering the full page width."""
    seen, centers = set(), []
    for w in labels:
        name = w[4].strip().lower().strip(".:")
        c = (w[0] + w[2]) / 2
        centers.append((c, name))
    centers.sort()
    # merge labels that wrap onto the same column ('Box' over 'Qty.')
    out = []
    for i, (c, name) in enumerate(centers):
        lo = 0.0 if i == 0 else (centers[i - 1][0] + c) / 2
        hi = 1e4 if i == len(centers) - 1 else (centers[i + 1][0] + c) / 2
        n, k = name, 2
        while n in seen:          # 'name'/'number' repeat on two-up item pages
            n, k = f"{name}{k}", k + 1
        seen.add(n)
        out.append((lo, hi, n))
    return out


def _cells(bands, cols):
    """[(y, {column: text})] for the body rows."""
    out = []
    for r in bands:
        cell = defaultdict(list)
        for w in r:
            x = (w[0] + w[2]) / 2
            for lo, hi, n in cols:
                if lo <= x < hi:
                    cell[n].append(w[4])
                    break
        if cell:
            out.append((r[0][1], {k: " ".join(v).strip() for k, v in cell.items()}))
    return out


def _first(cell, *names):
    for n in names:
        v = cell.get(n)
        if v:
            return v
    return ""


def parse_products(page):
    """Price rows on one page: model, description, size, finish, list price.

    Returns [] for pages with no price table (covers, marketing, terms).
    """
    words = page.get_text("words")
    bands = _bands(words)
    hi, yh, labels = _header_row(bands)
    if labels is None:
        return []
    cols = _columns(labels)
    colnames = {n for _, _, n in cols}
    if not ({"finish", "list", "price"} & colnames):
        return []          # item-number page or something else; not a price table
    body = _cells([r for r in bands[hi + 1:] if r[0][1] > yh + 5], cols)

    price_col = "list" if "list" in colnames else "price"
    # 1. price rows, in order; a box/case quantity starts a new size group.
    prices, groups = [], []
    for y, c in body:
        val = c.get(price_col, "")
        if not PRICE_RX.match(val.replace(" ", "")):
            continue
        if c.get("qty") or c.get("qty2") or not groups:
            groups.append([])
        rec = {
            "y": y,
            "finish": _first(c, "finish"),
            "list_price": float(val.replace("$", "").replace(",", "")),
            "box_qty": _first(c, "qty"),
            "case_qty": _first(c, "qty2"),
            "disc_code": _first(c, "code"),
            "desc_inline": _first(c, "description"),
            "size_inline": _first(c, "size"),
        }
        groups[-1].append(rec)
        prices.append(rec)
    if not prices:
        return []

    # 2. size text -> blocks, then each price row takes the NEAREST block by
    #    center. A size is vertically centered against the rows it owns, so it
    #    sits above some of them and below others; carry-forward and
    #    contains-in-span both mispair it. Pages without a pack-quantity column
    #    have only one qty group, so size cannot be derived from grouping either.
    margin = SIZE_LINE_GAP + 8   # a size may lead its first price row by a line
    lo_y, hi_y = prices[0]["y"] - margin, prices[-1]["y"] + margin
    blocks_sz = []
    for y, c in body:
        if not c.get("size") or not lo_y <= y <= hi_y:
            continue          # outside the price rows = footnote, not a size
        if blocks_sz and y - blocks_sz[-1][-1][0] <= SIZE_LINE_GAP:
            blocks_sz[-1].append((y, c["size"]))
        else:
            blocks_sz.append([(y, c["size"])])
    sizes = [((b[0][0] + b[-1][0]) / 2, " ".join(t for _, t in b)) for b in blocks_sz]

    for r in prices:
        r["size"] = (min(sizes, key=lambda s: abs(s[0] - r["y"]))[1]
                     if sizes else r["size_inline"])

    # 3. description blocks: a new product starts at a model-shaped token.
    descs = [(y, c["description"]) for y, c in body if c.get("description")]
    blocks, cur = [], None
    for y, txt in descs:
        head = txt.split()[0] if txt.split() else ""
        if MODEL_RX.match(head) and not PRICE_RX.match(head):
            cur = {"y": y, "model": head, "lines": [txt]}
            blocks.append(cur)
        elif cur is not None:
            cur["lines"].append(txt)
        else:                       # continuation from the previous page
            cur = {"y": y, "model": None, "lines": [txt]}
            blocks.append(cur)

    def model_for(y):
        prev = [b for b in blocks if b["y"] <= y + 8]
        return prev[-1] if prev else (blocks[0] if blocks else None)

    out = []
    for g in groups:
        qty = " / ".join(v for v in (g[0]["box_qty"], g[0]["case_qty"]) if v) if g else ""
        for r in g:
            blk = model_for(r["y"])
            desc = " ".join(blk["lines"]) if blk else r["desc_inline"]
            out.append({
                "model": (blk or {}).get("model"),
                "description": re.sub(r"\s+", " ", desc).strip(),
                "size": (r["size"] or r["size_inline"]).strip(),
                "finish": r["finish"],
                "list_price": r["list_price"],
                "qty": qty,
                "disc_code": r["disc_code"],
            })
    return out


LINE_TOK_RX = re.compile(r"^[A-Z0-9][A-Z0-9./#&-]*$", re.I)


def _is_model_cell(cell):
    """Does this leading cell look like a catalogue number, and nothing else?

    Accepts '10-9012' (ASI), 'B-166 1824' (Bobrick), '8B1-2012496-BB'
    (Bradley). Rejects prose, bare quantities and weights - a number alone is
    never a model, or every shipping weight in the book becomes a product.
    """
    toks = cell.split()
    if not 1 <= len(toks) <= 3 or not all(LINE_TOK_RX.match(t) for t in toks):
        return False
    j = "".join(toks)
    return (len(j) >= 3 and any(c.isdigit() for c in j)
            and ("-" in j or any(c.isalpha() for c in j)))


def parse_line_items(page):
    """Flat one-line-per-product price rows: MODEL | description | ... | price.

    The fallback for every catalog that is not laid out like Hager's. ASI,
    Bobrick, Bradley and most vendor price lists put one product per printed
    line with the number first and the price last, and have no column-header
    band for `parse_products` to lock onto.

    ponytail: the price is the LAST price-shaped token on the line, which is
    right for every reference catalog here (shipping cube and weight print
    before it). A catalog that prints weight after price would need the column
    header read instead.
    """
    out = []
    for line in page_rows(page):
        cells = [c.strip() for c in line.split("  |  ") if c.strip()]
        if len(cells) < 3 or not _is_model_cell(cells[0]):
            continue
        pi = max((i for i, c in enumerate(cells) if PRICE_ANY.search(c)),
                 default=0)
        if pi == 0:
            continue
        price = PRICE_ANY.findall(cells[pi])[-1]
        mids = cells[1:pi]
        desc = max(mids, key=lambda c: sum(ch.isalpha() for ch in c))
        if sum(ch.isalpha() for ch in desc) < 8:
            continue          # no real description = not a product line
        out.append({
            "model": cells[0], "description": desc, "size": "", "finish": "",
            "list_price": float(price.replace("$", "").replace(",", "")),
            "qty": "", "disc_code": "",
        })
    return out


def parse_item_numbers(page):
    """'Product Name | Item Number' pages -> [(name, item_no)].

    These are two-up (two name/number pairs per line), so the pairing is done
    per half-page: the trailing all-digit token in a half is the item number.
    """
    words = page.get_text("words")
    bands = _bands(words)
    hi, yh, labels = _header_row(bands)
    if labels is None or not any(
            w[4].strip().lower().strip(".:") == "item" for w in labels):
        return []
    mid = page.rect.width / 2
    out = []
    for r in bands[hi + 1:]:
        for half in ([w for w in r if w[2] <= mid + 4],
                     [w for w in r if w[0] > mid - 4]):
            if len(half) < 2:
                continue
            toks = [w[4] for w in half]
            if ITEMNO_RX.match(toks[-1]) and len(toks) > 1:
                name = " ".join(toks[:-1]).strip()
                if name:
                    out.append((name, toks[-1]))
    return out


def page_rows(page, gap=14.0):
    """Page text as spatially ordered rows with column breaks marked '|'.

    Flat get_text() interleaves the description column with the price column,
    which silently pairs a price with the wrong product. This keeps them apart.
    """
    out = []
    for r in _bands(page.get_text("words")):
        parts, prev = [], None
        for w in r:
            if prev is not None and w[0] - prev > gap:
                parts.append("  |  ")
            parts.append(w[4])
            prev = w[2]
        line = " ".join(parts).replace(" |   ", "  |  ")
        if line.strip():
            out.append(line)
    return out


# ---------------------------------------------------------------------- index

SCHEMA = """
CREATE TABLE IF NOT EXISTS catalogs (
  catalog_id TEXT PRIMARY KEY, path TEXT, vendor TEXT, effective TEXT,
  pages INT, cover TEXT, indexed_at REAL, stamp TEXT,
  folder TEXT, multiplier TEXT
);
CREATE TABLE IF NOT EXISTS pages (
  catalog_id TEXT, page INT, section TEXT, subsection TEXT, cat_page TEXT,
  PRIMARY KEY (catalog_id, page)
);
CREATE TABLE IF NOT EXISTS products (
  catalog_id TEXT, page INT, section TEXT, subsection TEXT, model TEXT,
  description TEXT, size TEXT, finish TEXT, list_price REAL, qty TEXT,
  disc_code TEXT, division TEXT, csi_section TEXT, csi_name TEXT
);
CREATE INDEX IF NOT EXISTS ix_prod_model ON products (catalog_id, model);
CREATE INDEX IF NOT EXISTS ix_prod_div ON products (catalog_id, division);
CREATE TABLE IF NOT EXISTS item_numbers (
  catalog_id TEXT, page INT, section TEXT, name TEXT, item_no TEXT
);
CREATE INDEX IF NOT EXISTS ix_item_no ON item_numbers (catalog_id, item_no);
CREATE VIRTUAL TABLE IF NOT EXISTS page_text USING fts5(
  catalog_id UNINDEXED, page UNINDEXED, section UNINDEXED, body
);
"""


def db_path():
    base = os.environ.get("CATINT_CACHE") or os.path.join(
        os.path.expanduser("~"), ".cache", "catalog-intelligence")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "catalog.db")


def connect():
    con = sqlite3.connect(db_path())
    con.executescript(SCHEMA)
    for col in ("folder TEXT", "multiplier TEXT"):   # migrate pre-existing DBs
        try:
            con.execute(f"ALTER TABLE catalogs ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass
    return con


# Bump whenever the parsers or the CSI rules change. The cache is keyed on the
# file, so without this an existing index survives an upgrade unchanged and the
# improvement silently never reaches anyone who had already opened the catalog.
PARSER_VERSION = 2


def _stamp(path):
    st = os.stat(path)
    return f"{st.st_mtime_ns}:{st.st_size}:v{PARSER_VERSION}"


def catalog_id_for(path):
    p = os.path.abspath(path)
    return hashlib.sha1(f"{p}:{_stamp(p)}".encode()).hexdigest()[:16]


def index_catalog(path, con=None, force=False):
    """Index a catalog PDF. Cached by path+mtime+size; re-indexing is a no-op."""
    path = os.path.abspath(path)
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    own = con is None
    con = con or connect()
    cid = catalog_id_for(path)
    stamp = _stamp(path)

    row = con.execute("SELECT stamp FROM catalogs WHERE catalog_id=?", (cid,)).fetchone()
    if row and row[0] == stamp and not force:
        return cid, False

    doc = fitz.open(path)
    # Drop every previous index of this FILE, not just this catalog_id. The id
    # is derived from the stamp, so an edited file or a parser-version bump
    # mints a new one and would otherwise leave the old rows orphaned in the
    # database - where they still answer queries, with stale prices.
    for (old,) in con.execute(
            "SELECT catalog_id FROM catalogs WHERE path=? AND catalog_id!=?",
            (path, cid)).fetchall():
        for t in ("catalogs", "pages", "products", "item_numbers", "page_text"):
            con.execute(f"DELETE FROM {t} WHERE catalog_id=?", (old,))
    for t in ("pages", "products", "item_numbers", "page_text"):
        con.execute(f"DELETE FROM {t} WHERE catalog_id=?", (cid,))

    cover = doc[0].get_text("text")[:2000] if len(doc) else ""
    m = DATE_RX.search(cover)
    effective = m.group(1) if m else None
    # The folder a price book is filed under is the vendor, and is more
    # reliable than anything on a cover page that may be a distributor's.
    folder = os.path.basename(os.path.dirname(path))
    m = DOMAIN_RX.search(cover)
    vendor = folder or (m.group(1) if m else
                        os.path.splitext(os.path.basename(path))[0].split()[0])
    # Distributors file the multiplier in the filename (".375 Multiplier").
    # Carried as metadata only - never applied. See the note in server.py.
    m = MULT_RX.search(os.path.basename(path))
    multiplier = m.group(1) if m else None

    for pno in range(len(doc)):
        page = doc[pno]
        try:
            sec, sub = section_of(page)
            rows = page_rows(page)
            # column-header layout first; flat line-item layout is the fallback
            prods = parse_products(page) or parse_line_items(page)
            items = parse_item_numbers(page)
            cat_pg = catalog_page_no(page)
        except Exception:
            sec, sub, rows, prods, items, cat_pg = "", "", [], [], [], None

        con.execute("INSERT OR REPLACE INTO pages VALUES (?,?,?,?,?)",
                    (cid, pno + 1, sec, sub, cat_pg))
        if rows:
            con.execute("INSERT INTO page_text (catalog_id,page,section,body) "
                        "VALUES (?,?,?,?)", (cid, pno + 1, sec, "\n".join(rows)))
        for p in prods:
            blurb = f"{sec} {sub} {p['model'] or ''} {p['description']}"
            div, csi, cname = classify(blurb)
            con.execute("INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (cid, pno + 1, sec, sub, p["model"], p["description"],
                         p["size"], p["finish"], p["list_price"], p["qty"],
                         p["disc_code"], div, csi, cname))
        for name, no in items:
            con.execute("INSERT INTO item_numbers VALUES (?,?,?,?,?)",
                        (cid, pno + 1, sec, name, no))

    con.execute("INSERT OR REPLACE INTO catalogs VALUES (?,?,?,?,?,?,?,?,?,?)",
                (cid, path, vendor, effective, len(doc), cover, time.time(),
                 stamp, folder, multiplier))
    con.commit()
    doc.close()
    if own:
        con.close()
    return cid, True


_WS = re.compile(r"\s+")
_STRIP = re.compile(r"[‘’“”″′\"'`|,]")


def norm(s):
    """Normalize for verbatim comparison: case, quotes, separators, whitespace."""
    return _WS.sub(" ", _STRIP.sub(" ", s or "")).strip().upper()
