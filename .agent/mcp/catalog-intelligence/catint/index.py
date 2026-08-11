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

from . import workbook

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
# Letter-led codes (BB1279, IHTAB750, ETW-4) or digit-led stock numbers (1251).
# Trailing * is stripped in _normalize_model_token before matching.
MODEL_RX = re.compile(
    r"^(?:[A-Z]{1,8}-?\d{1,5}|[A-Z]{0,4}\d{2,5})[A-Z0-9./-]*$"
)
# A price is either comma-grouped (1,234.56) or a plain run of digits (4053.20). The old
# pattern was `\d{1,3}(?:,\d{3})*`, which silently required the separator above $999, so
# a four-figure price printed without one was invisible - ASI's $1,537.20 baby changing
# station parsed as $2.45 off the shipping-cube column instead.
_PRICE_BODY = r"(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}"

# Anchored: the WHOLE cell is a price. One optional space after the currency symbol is
# the only whitespace allowed - a cell holding two numbers ("813061  530.10") is an item
# number beside a price, not a price, and must not be mistaken for one.
PRICE_RX = re.compile(rf"^\$?[ ]?{_PRICE_BODY}$")

# Unanchored, for finding a price inside a longer line. `\b` was not enough: Bobrick
# prints `B-686` immediately before `16.99`, and a bare `\d+\.\d{2}` happily started
# mid-token and read the pair as $68,616.99 for a $120.60 grab bar. A price may not
# begin part-way through a word, a decimal or a hyphenated model number.
PRICE_ANY = re.compile(rf"(?<![\w.,-])\$?{_PRICE_BODY}(?!\d)")
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


def section_of(page, words=None):
    """Running head, e.g. 'Locks - 3800 Series' -> ('Locks', '3800 Series')."""
    words = page.get_text("words") if words is None else words
    top = [w for w in words if w[1] < 45]
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


def catalog_page_no(page, words=None):
    """The page number the book prints on itself - what a person would cite."""
    for w in (page.get_text("words") if words is None else words):
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


def _normalize_model_token(tok):
    """Catalogue number from a description head, or None if it is not one.

    Strips a trailing asterisk (Hager marks some codes that way) before matching.
    """
    if not tok:
        return None
    cleaned = tok.strip().rstrip("*")
    if not cleaned or PRICE_RX.match(cleaned):
        return None
    if MODEL_RX.match(cleaned):
        return cleaned
    return None


def _parse_price_cell(val):
    """Float from a validated price cell, or None."""
    val = (val or "").strip()
    if not PRICE_RX.match(val):
        return None
    return float(val.replace("$", "").replace(",", "").replace(" ", ""))


def parse_products(page, bands=None):
    """Price rows on one page: model, description, size, finish, list price.

    Returns [] for pages with no price table (covers, marketing, terms).
    Rows without a resolvable model are dropped — narrative + List pages must
    not pollute the product table; read those with get_page / FTS instead.
    """
    bands = _bands(page.get_text("words")) if bands is None else bands
    hi, yh, labels = _header_row(bands)
    if labels is None:
        return []
    cols = _columns(labels)
    colnames = {n for _, _, n in cols}
    if not ({"finish", "list", "price"} & colnames):
        return []          # item-number page or something else; not a price table
    body = _cells([r for r in bands[hi + 1:] if r[0][1] > yh + 5], cols)

    price_col = "list" if "list" in colnames else "price"
    # Two List columns and no Finish (Hager electric adder pages): steel/brass
    # vs stainless are material finishes, not a second unrelated price stream.
    dual_list = "list2" in colnames and "finish" not in colnames
    finish_primary = "Steel/Brass" if dual_list else ""
    finish_secondary = "Stainless Steel" if dual_list else ""

    # 1. price rows, in order; a box/case quantity starts a new size group.
    #    Dual-List rows emit two finishes at the same y and must share a group.
    prices, groups = [], []
    for y, c in body:
        # Validate and convert the SAME string. This tested `val.replace(" ", "")` and
        # then converted `val`, so a cell like "813061  530.10" passed the check as one
        # long number and raised ValueError on the way into float().
        variants = []
        primary = _parse_price_cell(c.get(price_col))
        if primary is not None:
            variants.append((_first(c, "finish") or finish_primary, primary))
        if dual_list:
            secondary = _parse_price_cell(c.get("list2"))
            if secondary is not None:
                variants.append((finish_secondary, secondary))
        if not variants:
            continue
        if c.get("qty") or c.get("qty2") or not groups:
            groups.append([])
        for finish, list_price in variants:
            rec = {
                "y": y,
                "finish": finish,
                "list_price": list_price,
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
    #    Orphan prose does not start a null-model block — those used to absorb
    #    every price below them on dual-List adder pages.
    descs = [(y, c["description"]) for y, c in body if c.get("description")]
    blocks, cur = [], None
    for y, txt in descs:
        head = txt.split()[0] if txt.split() else ""
        model = _normalize_model_token(head)
        if model:
            cur = {"y": y, "model": model, "lines": [txt]}
            blocks.append(cur)
        elif cur is not None:
            cur["lines"].append(txt)

    def model_for(y):
        prev = [b for b in blocks if b["y"] <= y + 8]
        return prev[-1] if prev else None

    out = []
    for g in groups:
        qty = " / ".join(v for v in (g[0]["box_qty"], g[0]["case_qty"]) if v) if g else ""
        for r in g:
            blk = model_for(r["y"])
            model = (blk or {}).get("model")
            if not model:
                continue          # no catalogue number → not a product row
            desc = " ".join(blk["lines"]) if blk else r["desc_inline"]
            out.append({
                "model": model,
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


def parse_line_items(page, rows=None):
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
    for line in (page_rows(page) if rows is None else rows):
        cells = [c.strip() for c in line.split("  |  ") if c.strip()]
        if len(cells) < 3 or not _is_model_cell(cells[0]):
            continue
        pi = max((i for i, c in enumerate(cells) if PRICE_ANY.search(c)),
                 default=0)
        # Need at least one cell between the model and the price to read a description
        # from. `pi == 1` left `mids` empty and max() raised, and because index_catalog
        # catches per page, one such line discarded the WHOLE page - section, text,
        # products and item numbers. ASI pages 36-37 were missing entirely.
        if pi < 2:
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


def _trailing_prices(cells):
    """How many of the last cells are prices, and their values."""
    values = []
    for cell in reversed(cells):
        if PRICE_RX.match(cell.replace("$", "").strip()) or (
                PRICE_ANY.fullmatch(cell.strip()) if hasattr(PRICE_ANY, "fullmatch")
                else False):
            values.append(float(cell.replace("$", "").replace(",", "").strip()))
        else:
            break
    values.reverse()
    return values


def parse_price_matrix(rows):
    """Rows priced across a row of column headings, rather than down a price column.

    NGP prices one threshold across four door widths (36" 48" 72" 96"); NUDO prices one
    FRP panel size across four quantity breaks (25-99, 100-299, 300-599, 600+). Both
    print a heading row and then one line per product with N prices on it. Neither has a
    column called "List", so `_header_row` never fires and `parse_line_items` rejects
    the rows for having no description - between them, 88 pages of NGP and every NUDO
    panel produced nothing at all.

    The headings become the `size` of each row, which is what they are: the same model
    costs a different amount at a different width or quantity.

    Used only when both other parsers come back empty, so it cannot change a book that
    already reads.
    """
    out = []
    # `code` is a product code on its own line ("LP-F9"); `heading` is the descriptive
    # first cell of the row that labels the columns. NUDO prints both, one above the
    # other, and they are both part of what the product is - letting the heading
    # overwrite the code dropped the orderable code entirely.
    labels, code, heading = [], "", ""

    for line in rows:
        cells = [c.strip() for c in line.split("  |  ") if c.strip()]
        if not cells:
            continue
        prices = _trailing_prices(cells)
        prefix = cells[:len(cells) - len(prices)]

        # No prices: either a product code on its own line, or the heading row whose
        # cells name the columns beneath it.
        if len(prices) < 2:
            if len(cells) == 1:
                # Only a product code on its own line ("LP-F9"). Accepting any longish
                # cell swallowed the running head, and NGP letter-spaces its banner
                # ("J U N E 8 , 2 0 2 6") so it lands as one very long cell.
                if _is_model_cell(cells[0]):
                    code, heading = cells[0], ""
            elif len(cells) >= 2:
                head, rest = cells[0], cells[1:]
                # A long first cell describes the block; the rest label the columns.
                if len(rest) >= 2 and sum(ch.isalpha() for ch in head) >= 6:
                    heading, labels = head, rest
                else:
                    labels = cells
            continue

        model = next((c for c in prefix if _is_model_cell(c)), None)
        if not model:
            continue
        # The block heading and the row's own cells, in order and without repeating
        # either - the two overlap whenever a row carries nothing but its model.
        parts = []
        for part in [code, heading] + [c for c in prefix if c != model]:
            if part and part not in parts:
                parts.append(part)
        description = re.sub(r"\s+", " ", " ".join(parts)).strip()
        if not description:
            continue

        columns = labels[-len(prices):] if len(labels) >= len(prices) else []
        for i, price in enumerate(prices):
            out.append({
                "model": model,
                "description": description,
                "size": columns[i] if i < len(columns) else "",
                "finish": "",
                "list_price": price,
                "qty": "",
                "disc_code": "",
            })
    return out


def parse_item_numbers(page, bands=None):
    """'Product Name | Item Number' pages -> [(name, item_no)].

    These are two-up (two name/number pairs per line), so the pairing is done
    per half-page: the trailing all-digit token in a half is the item number.
    """
    bands = _bands(page.get_text("words")) if bands is None else bands
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


def page_rows(page, gap=14.0, bands=None):
    """Page text as spatially ordered rows with column breaks marked '|'.

    Flat get_text() interleaves the description column with the price column,
    which silently pairs a price with the wrong product. This keeps them apart.
    """
    out = []
    for r in (_bands(page.get_text("words")) if bands is None else bands):
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
-- `list_price` is the number; `price_basis` says WHICH number it is. A PDF price book
-- prints one price column and it is list, but a distributor spreadsheet prints several
-- side by side (LIST | DEALER | COMMERCIAL | MAP | HAMILTON PARKER NET) and they are
-- not interchangeable: applying a vendor multiplier to an already-net price
-- under-prices the job. Every row says where its number came from.
CREATE TABLE IF NOT EXISTS products (
  catalog_id TEXT, page INT, section TEXT, subsection TEXT, model TEXT,
  description TEXT, size TEXT, finish TEXT, list_price REAL, qty TEXT,
  disc_code TEXT, division TEXT, csi_section TEXT, csi_name TEXT,
  price_basis TEXT
);
CREATE INDEX IF NOT EXISTS ix_prod_model ON products (catalog_id, model);
CREATE INDEX IF NOT EXISTS ix_prod_div ON products (catalog_id, division);
CREATE TABLE IF NOT EXISTS item_numbers (
  catalog_id TEXT, page INT, section TEXT, name TEXT, item_no TEXT
);
CREATE INDEX IF NOT EXISTS ix_item_no ON item_numbers (catalog_id, item_no);
-- Manufacturer crossover tables ("this Bobrick model equals this ASI model"), stored as
-- equivalence CLASSES rather than directed pairs: one class_id per printed row, one row
-- here per member. The Shandas sheet is 409 classes; as pairs it would be 3,162 rows
-- saying the same thing.
--
-- Reference data, so it belongs beside the catalog index and NOT in the OKF graph.
-- graph.json holds 35 learned facts and is re-read and re-validated in full on every
-- call; adding thousands of published crossovers would bury what CBC actually learned.
CREATE TABLE IF NOT EXISTS crossovers (
  catalog_id TEXT, class_id TEXT, vendor TEXT, model TEXT, sheet TEXT
);
CREATE INDEX IF NOT EXISTS ix_cross_model ON crossovers (model);
CREATE INDEX IF NOT EXISTS ix_cross_class ON crossovers (class_id);
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
    # WAL so a long indexing write does not block readers. The frontend opens this same
    # file read-only; under the default rollback journal it got SQLITE_BUSY for the
    # minutes an index took, swallowed it, and rendered the shelf as empty.
    try:
        con.execute("PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError:
        pass          # read-only media or a filesystem without shared-memory support
    con.executescript(SCHEMA)
    for table, col in (("catalogs", "folder TEXT"), ("catalogs", "multiplier TEXT"),
                       ("products", "price_basis TEXT")):   # migrate pre-existing DBs
        try:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {col}")
        except sqlite3.OperationalError:
            pass
    return con


# Bump whenever the parsers or the CSI rules change. The cache is keyed on the
# file, so without this an existing index survives an upgrade unchanged and the
# improvement silently never reaches anyone who had already opened the catalog.
PARSER_VERSION = 4

# How often index_catalog checkpoints. Small enough that a reader on the WAL sees the
# index filling in, large enough that fsync is not the bottleneck.
COMMIT_EVERY_PAGES = 50


def _stamp(path):
    st = os.stat(path)
    return f"{st.st_mtime_ns}:{st.st_size}:v{PARSER_VERSION}"


def catalog_id_for(path):
    p = os.path.abspath(path)
    return hashlib.sha1(f"{p}:{_stamp(p)}".encode()).hexdigest()[:16]


# A book is only handed to the matrix parser when the ordinary parsers found almost
# nothing in it. Measured across this shelf the split is unambiguous: the books that
# need it sit at 0-3.4% of pages parsed, and the next one up is at 6.8%.
#
# The gate matters because the matrix parser is credulous by design - it takes the last
# run of numbers on a line as prices and the first model-shaped cell as the model. On a
# book that already reads, that is wrong: Pemko p67 gives it `11 | 1/2 x 7 | 176A |
# Aluminum | $199.26 | ...` and it takes the SIZE as the model, and Rockwood's finish
# matrices merge several prices into one cell so most of them are silently dropped.
MATRIX_FALLBACK_RATIO = 0.05


def _matrix_pass(con, cid, doc):
    """Second look at a book the ordinary parsers could not read.

    NGP prices a threshold across four door widths and NUDO prices a panel across four
    quantity breaks; neither prints a column called "List", so nothing recognised them
    and 88 pages of NGP yielded 15 rows. Runs only on pages that produced nothing, and
    only for a book that produced almost nothing overall.
    """
    parsed = con.execute(
        "SELECT COUNT(DISTINCT page) FROM products WHERE catalog_id=?", (cid,)
    ).fetchone()[0]
    if parsed >= max(1, len(doc) * MATRIX_FALLBACK_RATIO):
        return 0

    done = {p for (p,) in con.execute(
        "SELECT DISTINCT page FROM products WHERE catalog_id=?", (cid,))}
    added = 0
    for pno in range(len(doc)):
        if pno + 1 in done:
            continue
        try:
            rows = page_rows(doc[pno])
            prods = parse_price_matrix(rows)
        except Exception:
            continue
        for p in prods:
            blurb = f"{p['model'] or ''} {p['description']}"
            div, csi, cname = classify(blurb)
            con.execute("INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (cid, pno + 1, "", "", p["model"], p["description"],
                         p["size"], p["finish"], p["list_price"], p["qty"],
                         p["disc_code"], div, csi, cname, "list"))
            added += 1
    return added


def _clear_catalog(con, path, cid):
    """Drop every previous index of this FILE, not just this catalog_id.

    The id is derived from the stamp, so an edited file or a parser-version bump mints a
    new one and would otherwise leave the old rows orphaned in the database - where they
    still answer queries, with stale prices.

    Also drops the process-local normalized-text cache: a `force=True` rebuild keeps the
    same catalog_id (path+mtime unchanged), and verify_facts would otherwise keep answering
    from the pre-rebuild snapshot — the same hole BPI closed for vision rewrites.
    """
    for (old,) in con.execute(
            "SELECT catalog_id FROM catalogs WHERE path=? AND catalog_id!=?",
            (path, cid)).fetchall():
        for t in ("catalogs", "pages", "products", "item_numbers", "page_text",
                  "crossovers"):
            con.execute(f"DELETE FROM {t} WHERE catalog_id=?", (old,))
        invalidate_norm_cache(old)
    for t in ("pages", "products", "item_numbers", "page_text", "crossovers"):
        con.execute(f"DELETE FROM {t} WHERE catalog_id=?", (cid,))
    invalidate_norm_cache(cid)


def index_workbook(path, con, cid, stamp):
    """Index a spreadsheet price list into the same tables a PDF price book fills.

    One worksheet is treated as one page, so `[catalog] GAMCO p.1` resolves the same way
    for a spreadsheet as for a book, and every existing tool works unchanged.
    """
    _clear_catalog(con, path, cid)
    folder = os.path.basename(os.path.dirname(path))
    m = MULT_RX.search(os.path.basename(path))
    multiplier = m.group(1) if m else None

    # A crossover sheet names other vendors' equivalents and prices nothing, so it goes
    # to its own table rather than being read as an empty price list.
    source_vendor = os.path.splitext(os.path.basename(path))[0].split()[0]
    for sheet_name, classes in workbook.parse_workbook_crossovers(path, source_vendor):
        for n, members in enumerate(classes):
            class_id = f"{cid}:{sheet_name}:{n}"
            for vendor, model in members:
                con.execute("INSERT INTO crossovers VALUES (?,?,?,?,?)",
                            (cid, class_id, vendor, model, sheet_name))

    sheets = workbook.parse_workbook(path)
    for pno, (sheet_name, rows) in enumerate(sheets, start=1):
        con.execute("INSERT OR REPLACE INTO pages VALUES (?,?,?,?,?)",
                    (cid, pno, sheet_name, "", None))
        body = "\n".join(
            f"{r['model']}  |  {r['description']}  |  {r['price_column']}  |  "
            f"{r['list_price']}" for r in rows)
        if body:
            con.execute("INSERT INTO page_text (catalog_id,page,section,body) "
                        "VALUES (?,?,?,?)", (cid, pno, sheet_name, body))
        for r in rows:
            div, csi, cname = classify(f"{r['section']} {r['model']} {r['description']}")
            con.execute("INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (cid, pno, r["section"], sheet_name, r["model"],
                         r["description"], r["size"], r["finish"], r["list_price"],
                         r["qty"], r["disc_code"], div, csi, cname, r["price_basis"]))

    con.execute("INSERT OR REPLACE INTO catalogs VALUES (?,?,?,?,?,?,?,?,?,?)",
                (cid, path, folder, None, len(sheets), "", time.time(), stamp,
                 folder, multiplier))
    con.commit()
    return cid, True


def index_catalog(path, con=None, force=False):
    """Index a price book. Cached by path+mtime+size; re-indexing is a no-op.

    Accepts a PDF or a spreadsheet - `.xlsx` price lists carry a large part of this
    shelf's pricing and used to be unreadable, so the whole vendor showed as uncovered.
    """
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

    if workbook.is_workbook(path):
        try:
            return index_workbook(path, con, cid, stamp)
        finally:
            if own:
                con.close()

    doc = fitz.open(path)
    _clear_catalog(con, path, cid)

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
            # One extraction and one banding per page, shared by every parser below.
            # These used to take a `page` and each call get_text("words") themselves -
            # five to six extractions per page, of the single call this module's
            # docstring identifies as the cost of indexing.
            words = page.get_text("words")
            bands = _bands(words)
            sec, sub = section_of(page, words)
            rows = page_rows(page, bands=bands)
            # Column-header layout first, flat line-item layout second. The matrix
            # parser is NOT tried here - see the document-level pass below.
            prods = parse_products(page, bands) or parse_line_items(page, rows)
            items = parse_item_numbers(page, bands)
            cat_pg = catalog_page_no(page, words)
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
            con.execute("INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (cid, pno + 1, sec, sub, p["model"], p["description"],
                         p["size"], p["finish"], p["list_price"], p["qty"],
                         p["disc_code"], div, csi, cname,
                         p.get("price_basis") or "list"))
        for name, no in items:
            con.execute("INSERT INTO item_numbers VALUES (?,?,?,?,?)",
                        (cid, pno + 1, sec, name, no))

        # Commit in chunks rather than holding one transaction across the whole book.
        # The `catalogs` row is written last, so a crash mid-index leaves orphan page
        # rows under a catalog_id no query resolves - re-indexing clears them by path.
        if pno % COMMIT_EVERY_PAGES == COMMIT_EVERY_PAGES - 1:
            con.commit()

    _matrix_pass(con, cid, doc)

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


# Normalized page bodies, keyed by catalog_id. verify_facts is documented as the thing
# to run before reporting ANY model number or price, so it is the hottest tool here, and
# it used to re-normalize the whole book - two regex passes over every page - on every
# call. catalog_id hashes path+mtime+PARSER_VERSION, so a changed file is a new key —
# but force=True rebuilds keep the same id, so `_clear_catalog` must invalidate.
#
# NOT narrowed through FTS: verify_facts matches substrings, while FTS matches whole
# tokens, so an FTS prefilter drops real hits ("US26" inside "US26D", "Collar" inside
# "Collars"). The scan stays exhaustive; only the normalization is cached.
_NORM_CACHE = {}
_NORM_CACHE_MAX = 3


def invalidate_norm_cache(catalog_id):
    """Drop a catalog's normalized text after its page_text rows are rewritten."""
    _NORM_CACHE.pop(catalog_id, None)


def normalized_pages(con, catalog_id):
    """[(page, section, normalized body)] for a catalog, normalized at most once."""
    cached = _NORM_CACHE.get(catalog_id)
    if cached is None:
        cached = [(p, s, norm(b)) for p, s, b in con.execute(
            "SELECT page, section, body FROM page_text WHERE catalog_id=?",
            (catalog_id,))]
        if len(_NORM_CACHE) >= _NORM_CACHE_MAX:
            _NORM_CACHE.pop(next(iter(_NORM_CACHE)))
        _NORM_CACHE[catalog_id] = cached
    return cached
