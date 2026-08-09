"""catalog-intelligence MCP server.

Turns a vendor price book / product catalog PDF into a queryable product index:
CSI division coverage, price rows (model / size / finish / list price), item
numbers, and full text. It owns no model - the calling IDE's LLM does the
specifying. Its job is to make sure that LLM never has to guess a model number
or a price.

Pairs with building-plan-intelligence: that server says what the drawings
require, this one says what the vendor actually sells against it.
"""

import asyncio
import json
import re

import fitz
from mcp.server.mcpserver import MCPServer

from . import index as ix
from . import overrides as ov

mcp = MCPServer(
    name="catalog-intelligence",
    instructions=(
        "Queries vendor price books / product catalogs (PDF and .xlsx price lists).\n"
        "WORKFLOW: 0) list_catalogs to see what is already indexed. "
        "1) open_catalog(path) only for a book missing from that list — "
        "never open every file on the shelf. 2) list_division to enumerate "
        "everything in a division. 3) match_materials to map a plan's "
        "requirements onto real catalog products. 4) lookup_product for exact "
        "model pricing/finishes. 5) verify_facts on every model number and "
        "price before you answer.\n"
        "ALSO: lookup_crossover for another manufacturer's equivalent of a model; "
        "list_price_overrides / record_price_override for prices an estimator has "
        "confirmed by hand, which outrank anything parsed here.\n"
        "FIVE RULES THAT PREVENT WRONG ANSWERS:\n"
        "0. Read `price_basis` on every price. It says whether the number is a LIST "
        "price or already a NET cost. `already_net: true` means a multiplier has "
        "ALREADY been applied - applying the vendor's multiplier again under-prices "
        "the job. Quote the basis with the number, every time.\n"
        "1. Coverage first. A catalog covers the divisions in `divisions`, and "
        "NOTHING ELSE. A door-hardware book has no toilet partitions in it. If the "
        "asked-for division is absent, say so - do not substitute a product from "
        "another division and do not supply one from your own product knowledge.\n"
        "2. A PDF price book prints LIST prices, and net cost needs the vendor's "
        "multiplier sheet - a separate document. A distributor spreadsheet may print "
        "list, dealer, commercial, MAP and net side by side; those are different "
        "numbers and `price_basis` says which one you have. Never present a list price "
        "as a cost, and never total without saying which basis you used.\n"
        "3. Enumerate. list_division returns every model it found; report all of "
        "them, and report the `unclassified` count so the caller knows the tail "
        "exists. Never claim a division is complete when pages went unparsed - "
        "check `sections_without_price_rows` and read those with get_page.\n"
        "4. Verify. Run verify_facts on every model number, item number, finish "
        "code and price before reporting it. Anything unverified is not in this "
        "catalog - drop it.\n"
        "A price row is (model, size, finish) -> price. The SAME model costs "
        "different amounts in different finishes and sizes; never quote a model's "
        "price without naming the finish and size it belongs to."
    ),
)


STOPWORDS = {"and", "the", "for", "with", "type", "all", "each", "per", "any",
             "new", "shall", "provide", "typ", "std"}

# Catalogs write "Coat Hook", plans write "coat hooks". Matching the singular
# stem covers both; anything with a digit is a model number and is left alone
# ("891S" must not become "891").
def _stem(t):
    t = t.lower()
    if len(t) > 3 and t.endswith("s") and not t.endswith("ss") \
            and not any(c.isdigit() for c in t):
        return t[:-1]
    return t


def _con():
    return ix.connect()


def _cat(con, catalog_id):
    row = con.execute(
        "SELECT path, vendor, effective, pages FROM catalogs WHERE catalog_id=?",
        (catalog_id,)).fetchone()
    if not row:
        raise ValueError(f"unknown catalog_id {catalog_id!r}; call open_catalog first")
    return row


def _scope(con, catalog_id):
    """('AND catalog_id=?', [id], vendor_map) - or every indexed catalog.

    An empty catalog_id means "search everything indexed". With one price book
    per vendor that is the question actually being asked most of the time:
    which vendor carries this, not does this one.

    Returns (None, None, {}) when the shelf is empty so callers can return a
    structured hint instead of raising — a bare ValueError pushed agents into
    open_catalog spam loops.
    """
    vendors = {c: (v, f) for c, v, f in con.execute(
        "SELECT catalog_id, vendor, folder FROM catalogs")}
    if catalog_id:
        _cat(con, catalog_id)
        return " AND catalog_id=?", [catalog_id], vendors
    if not vendors:
        return None, None, {}
    return "", [], vendors


EMPTY_SHELF = {
    "error": "no_catalogs_indexed",
    "message": "No catalogs are indexed yet.",
    "hint": (
        "Call list_catalogs first. Only call open_catalog for a book that is "
        "missing from that list — do not open every PDF on the shelf."
    ),
    "products": [],
    "count": 0,
}


def _coverage(con, cid, pages):
    """How much of this catalog became structured product rows.

    With a shelf of vendors this is the routing signal that matters: a
    `text_only` catalog will return nothing from list_division no matter how
    many products the vendor actually sells, and must be read with get_page.
    """
    got = con.execute("SELECT COUNT(DISTINCT page) FROM products WHERE "
                      "catalog_id=?", (cid,)).fetchone()[0]
    if not got:
        return "text_only", got
    return ("structured" if got >= max(1, pages) * 0.3 else "partial"), got


def _prod_json(r):
    basis = (r[9] if len(r) > 9 else None) or "list"
    return {"model": r[0], "description": r[1], "size": r[2], "finish": r[3],
            "price": r[4],
            "price_basis": basis,
            "already_net": basis in NET_BASES,
            # Kept alongside `price` so nothing that already reads this key breaks. For
            # a PDF price book the two are identical and always were; only spreadsheet
            # rows can carry a non-list basis, and `price_basis` is what says so.
            "list_price": r[4],
            "pack_qty": r[5], "disc_code": r[6],
            "page": r[7], "section": r[8]}


PROD_COLS = ("model, description, size, finish, list_price, qty, disc_code, "
             "page, section, price_basis")

# Bases that are already a cost to CBC. Applying a vendor multiplier on top of one of
# these under-prices the job, which is the single most expensive mistake this index can
# cause, so every price says which it is.
NET_BASES = {"net", "dealer_net", "distributor_net", "hamilton_parker_net"}

PRICE_BASIS_NOTE = (
    "Every price carries a `price_basis` saying WHICH price it is, and `already_net` "
    "saying whether it is a cost. A PDF price book prints one column and it is LIST: "
    "net cost needs the vendor's multiplier sheet, a separate document. A distributor "
    "spreadsheet prints several columns side by side (list / dealer / commercial / map "
    "/ distributor net / hamilton parker net) and they are NOT interchangeable. Never "
    "apply a multiplier to a row whose `already_net` is true, and never present a LIST "
    "price as a cost. Quote the basis alongside the number.")

# Kept under the old name so nothing that referenced it silently loses the warning.
LIST_PRICE_NOTE = PRICE_BASIS_NOTE


@mcp.tool()
def open_catalog(pdf_path: str) -> str:
    """Index a vendor catalog / price book PDF and return its catalog_id.

    Cached by file mtime/size - calling it again on an unchanged file is cheap.
    Always call this first; every other tool takes the catalog_id it returns.

    The `divisions` field is the honest scope of this catalog. Treat any CSI
    division missing from it as not covered here.
    """
    con = _con()
    try:
        cid, built = ix.index_catalog(pdf_path, con)
        path, vendor, effective, pages = _cat(con, cid)
        divs = con.execute(
            "SELECT division, csi_section, csi_name, COUNT(*), COUNT(DISTINCT model) "
            "FROM products WHERE catalog_id=? AND division IS NOT NULL "
            "GROUP BY division, csi_section ORDER BY 4 DESC", (cid,)).fetchall()
        unclass = con.execute(
            "SELECT COUNT(*) FROM products WHERE catalog_id=? AND division IS NULL",
            (cid,)).fetchone()[0]
        # A page is a real gap only if it shows prices yet yielded no price rows.
        # Pages of item numbers, terms and marketing have none, and reporting
        # those as gaps would make the caller distrust a complete answer.
        gaps = {}
        covered = {p for (p,) in con.execute(
            "SELECT DISTINCT page FROM products WHERE catalog_id=?", (cid,))}
        covered |= {p for (p,) in con.execute(
            "SELECT DISTINCT page FROM item_numbers WHERE catalog_id=?", (cid,))}
        for page, section, body in con.execute(
                "SELECT page, section, body FROM page_text WHERE catalog_id=?", (cid,)):
            if page in covered or not section:
                continue
            if len(ix.PRICE_ANY.findall(body)) < 6:
                continue
            gaps.setdefault(section, []).append(page)
        folder, mult = con.execute(
            "SELECT folder, multiplier FROM catalogs WHERE catalog_id=?",
            (cid,)).fetchone()
        return json.dumps({
            "catalog_id": cid,
            "path": path,
            "vendor": vendor,
            "vendor_folder": folder,
            "effective": effective,
            "multiplier_in_filename": mult,
            "pages": pages,
            "coverage": _coverage(con, cid, pages)[0],
            "newly_indexed": built,
            "price_rows": con.execute(
                "SELECT COUNT(*) FROM products WHERE catalog_id=?", (cid,)).fetchone()[0],
            "models": con.execute(
                "SELECT COUNT(DISTINCT model) FROM products WHERE catalog_id=?",
                (cid,)).fetchone()[0],
            "item_numbers": con.execute(
                "SELECT COUNT(*) FROM item_numbers WHERE catalog_id=?", (cid,)).fetchone()[0],
            "divisions": [
                {"division": f"Division {d} - {ix.DIVISION_NAMES.get(d, '?')}",
                 "csi_section": f"{s} {n}", "price_rows": c, "models": m}
                for d, s, n, c, m in divs],
            "unclassified_price_rows": unclass,
            "sections_without_price_rows": [
                {"section": s, "page_count": len(p), "pages": p[:40]}
                for s, p in sorted(gaps.items(), key=lambda kv: -len(kv[1]))],
            "notes": [
                LIST_PRICE_NOTE,
                "`divisions` is the full CSI scope of this catalog. A division "
                "not listed is not sold in this book.",
                "`sections_without_price_rows` use a layout the row parser does "
                "not read (transposed tables, or per-foot formula pricing). "
                "Their text IS indexed - use get_page / search_catalog on those "
                "pages and read the prices yourself.",
                "`multiplier_in_filename` was read off the FILE NAME, not the "
                "document. It is a routing hint, never an authority: confirm it "
                "against the vendor's multiplier sheet before applying it, and "
                "state that you applied it whenever you quote a net number.",
                "`coverage`: 'structured' = product rows across the book, trust "
                "list_division. 'partial' = some pages parsed, the rest need "
                "get_page. 'text_only' = NO product rows at all (finish-matrix "
                "pricing, per-foot formulas, or a catalog with no prices); "
                "list_division and match_materials will find nothing here, so "
                "use search_catalog + get_page and never read their silence as "
                "'this vendor does not carry it'.",
            ],
        }, indent=2)
    finally:
        con.close()


@mcp.tool()
def list_catalogs() -> str:
    """Every catalog indexed so far: vendor, effective date, CSI divisions, size.

    Call this FIRST when several vendors are in play, to see what is already
    indexed and which vendor to route a requirement to. Anything not listed here
    has not been opened yet - `open_catalog` it before relying on its absence.
    """
    con = _con()
    try:
        rows = con.execute(
            "SELECT catalog_id, vendor, folder, effective, multiplier, pages, path "
            "FROM catalogs ORDER BY folder, path").fetchall()
        out = []
        for cid, vendor, folder, eff, mult, pages, path in rows:
            divs = con.execute(
                "SELECT csi_section, csi_name, COUNT(DISTINCT model) FROM products "
                "WHERE catalog_id=? AND csi_section IS NOT NULL GROUP BY csi_section "
                "ORDER BY 3 DESC", (cid,)).fetchall()
            n = con.execute("SELECT COUNT(*), COUNT(DISTINCT model) FROM products "
                            "WHERE catalog_id=?", (cid,)).fetchone()
            cov, npages = _coverage(con, cid, pages)
            out.append({
                "catalog_id": cid, "vendor": vendor, "folder": folder,
                "effective": eff, "multiplier_in_filename": mult,
                "pages": pages, "coverage": cov, "pages_parsed": npages,
                "price_rows": n[0], "models": n[1],
                "csi_sections": [f"{s} {nm} ({m} models)" for s, nm, m in divs],
                "file": path,
            })
        text_only = [c["file"] for c in out if c["coverage"] == "text_only"]
        return json.dumps({
            "catalogs": len(out),
            "indexed": out,
            "notes": [
                "`list_division` and `match_materials` accept catalog_id=\"\" to "
                "search EVERY catalog at once and report which vendor carries "
                "what - use that rather than looping.",
                "Catalogs with coverage 'text_only' have NO structured product "
                "rows and are invisible to list_division / match_materials. "
                "Their text is searchable: use search_catalog + get_page. Never "
                "report a product as unavailable on the strength of their "
                "silence." if text_only else
                "Every indexed catalog produced structured product rows.",
            ],
            "text_only_catalogs": text_only,
        }, indent=2)
    finally:
        con.close()


@mcp.tool()
def list_division(catalog_id: str, division: str, limit: int = 400) -> str:
    """Every product in a CSI division. START HERE for 'list all the Division N
    items'.

    `catalog_id` may be **""** to search every indexed catalog at once — with
    several vendors on the shelf that is usually what you want, and the result
    names the vendor carrying each product.

    `division` accepts '10', 'Division 10', or a full section like '10 28 00'.

    An empty result plus `covered_divisions` is a real answer: report it as "no
    indexed catalog covers Division N" rather than reaching for another product.
    """
    con = _con()
    try:
        where, args0, vendors = _scope(con, catalog_id)
        if where is None:
            return json.dumps({**EMPTY_SHELF, "division": division})
        d = re.sub(r"(?i)^division\s*", "", division).strip()
        num = d.split()[0].zfill(2) if d else ""
        full = d if len(d.split()) > 1 else None

        q = (f"SELECT {PROD_COLS}, csi_section, csi_name, catalog_id FROM products "
             f"WHERE division=?{where}")
        args = [num] + args0
        if full:
            q += " AND csi_section=?"
            args.append(full)
        rows = con.execute(q + " ORDER BY csi_section, model, size, finish",
                           args).fetchall()

        # PROD_COLS now ends with price_basis, so the trailing columns sit at 10-12.
        BASIS, CSI, CSI_NAME, CAT = 9, 10, 11, 12
        by_model = {}
        for r in rows[:limit * 12]:
            key = (r[CAT], r[0])         # same model number can exist in two books
            m = by_model.setdefault(key, {
                "vendor": vendors.get(r[CAT], ("?", "?"))[0],
                "catalog_id": r[CAT],
                "model": r[0], "csi_section": f"{r[CSI]} {r[CSI_NAME]}",
                "description": r[1], "section": r[8], "pages": set(),
                "sizes": set(), "finishes": set(), "ranges": {},
                "pack_qty": r[5]})
            m["pages"].add(r[7])
            if r[2]:
                m["sizes"].add(r[2])
            if r[3]:
                m["finishes"].add(r[3])
            # Per basis, never pooled. A model with list 13.50 and a distributor net of
            # 11.79 does not have a price "range" of 11.79-13.50 - those are two
            # different kinds of number and one of them is a cost.
            basis = r[BASIS] or "list"
            lo, hi = m["ranges"].get(basis, (r[4], r[4]))
            m["ranges"][basis] = (min(lo, r[4]), max(hi, r[4]))

        def span(pair):
            lo, hi = pair
            return f"${lo:,.2f}" if lo == hi else f"${lo:,.2f}-${hi:,.2f}"

        out = []
        for m in list(by_model.values())[:limit]:
            entry = {**m, "pages": sorted(m["pages"]),
                     "sizes": sorted(m["sizes"]),
                     "finishes": sorted(m["finishes"]),
                     "prices": {b: span(v) for b, v in sorted(m["ranges"].items())}}
            entry["price_bases"] = sorted(m["ranges"])
            entry["already_net"] = sorted(set(m["ranges"]) & NET_BASES)
            entry.pop("ranges")
            out.append(entry)

        scope = (f"catalog {catalog_id}" if catalog_id
                 else f"all {len(vendors)} indexed catalogs")
        # counted in SQL, not from `out` - `out` is capped by `limit`, and a
        # per-vendor tally taken from a truncated page silently drops vendors.
        vq = ("SELECT catalog_id, COUNT(DISTINCT model) FROM products "
              "WHERE division=?" + where)
        vargs = [num] + args0
        if full:
            vq += " AND csi_section=?"
            vargs.append(full)
        by_vendor = {}
        total_models = 0
        for c, n in con.execute(vq + " GROUP BY catalog_id ORDER BY 2 DESC", vargs):
            by_vendor[vendors.get(c, ("?", "?"))[0]] = \
                by_vendor.get(vendors.get(c, ("?", "?"))[0], 0) + n
            total_models += n
        res = {"division": division, "searched": scope, "models": total_models,
               "price_rows": len(rows), "models_by_vendor": by_vendor,
               "showing": len(out), "products": out, "note": LIST_PRICE_NOTE}
        if len(out) < total_models:
            res["truncated"] = (
                f"Showing {len(out)} of {total_models} models. Raise `limit`, or "
                "narrow with a full section ('10 28 00') or a single catalog_id, "
                "before telling the user this is the complete list.")
        if not rows:
            have = con.execute(
                "SELECT DISTINCT division FROM products WHERE division IS NOT NULL"
                + where + " ORDER BY 1", args0).fetchall()
            res["products"] = []
            res["covered_divisions"] = [
                f"Division {h[0]} - {ix.DIVISION_NAMES.get(h[0], '?')}" for h in have]
            res["action"] = (
                f"No {division} products in {scope}. Report that plainly. Do not "
                "substitute a product from a covered division and do not supply "
                "one from your own knowledge. If you searched a single catalog, "
                "retry with catalog_id=\"\" before concluding no vendor carries "
                "it; if you searched all of them, it is a genuine gap.")
        return json.dumps(res, indent=2, default=str)
    finally:
        con.close()


@mcp.tool()
def list_sections(catalog_id: str) -> str:
    """The catalog's own table of contents: sections, page ranges, CSI divisions.

    Use to orient before searching, and to find sections whose pages carry no
    parsed price rows (read those with get_page).
    """
    con = _con()
    try:
        _cat(con, catalog_id)
        rows = con.execute(
            "SELECT section, MIN(page), MAX(page), COUNT(*) FROM pages "
            "WHERE catalog_id=? AND section!='' GROUP BY section ORDER BY 2",
            (catalog_id,)).fetchall()
        out = []
        for sec, lo, hi, n in rows:
            divs = con.execute(
                "SELECT DISTINCT csi_section, csi_name FROM products WHERE "
                "catalog_id=? AND section=? AND csi_section IS NOT NULL",
                (catalog_id, sec)).fetchall()
            npr = con.execute(
                "SELECT COUNT(*), COUNT(DISTINCT model) FROM products WHERE "
                "catalog_id=? AND section=?", (catalog_id, sec)).fetchone()
            out.append({"section": sec, "pages": f"{lo}-{hi}", "page_count": n,
                        "price_rows": npr[0], "models": npr[1],
                        "csi": [f"{a} {b}" for a, b in divs]})
        return json.dumps({"sections": out}, indent=2)
    finally:
        con.close()


@mcp.tool()
def lookup_product(catalog_id: str, model: str) -> str:
    """Every price row for a model: each size x finish combination with its
    list price, pack quantity and page.

    A model does NOT have one price. Quote the row whose size and finish match
    what the specification actually calls for, and if the spec does not pin a
    finish, report the range rather than picking one.
    """
    con = _con()
    try:
        _cat(con, catalog_id)
        m = model.strip().upper()
        rows = con.execute(
            f"SELECT {PROD_COLS} FROM products WHERE catalog_id=? AND "
            "(UPPER(model)=? OR UPPER(model) LIKE ?) ORDER BY size, finish",
            (catalog_id, m, m + "%")).fetchall()
        items = con.execute(
            "SELECT name, item_no, page FROM item_numbers WHERE catalog_id=? AND "
            "UPPER(name) LIKE ? LIMIT 60", (catalog_id, m + "%")).fetchall()
        folder = con.execute(
            "SELECT COALESCE(folder, vendor) FROM catalogs WHERE catalog_id=?",
            (catalog_id,)).fetchone()[0]
        verified = ov.for_model(folder, model)

        if not rows and not items and not verified:
            near = con.execute(
                "SELECT DISTINCT model FROM products WHERE catalog_id=? AND "
                "model LIKE ? LIMIT 25", (catalog_id, "%" + m + "%")).fetchall()
            return json.dumps({
                "model": model, "found": False,
                "similar_models": [n[0] for n in near],
                "action": ("Not in this catalog. Do not report a price for it. "
                           "Check similar_models, or search_catalog for the "
                           "description instead of the model."),
            }, indent=2)

        payload = {
            "model": model,
            "price_rows": [_prod_json(r) for r in rows],
            "order_item_numbers": [
                {"name": n, "item_no": i, "page": p} for n, i, p in items],
            "note": PRICE_BASIS_NOTE,
        }
        if verified:
            # First key in the payload, and said plainly: a person checked this number
            # against the book and the parser did not.
            payload = {
                "model": model,
                "verified_prices": verified,
                "action": (
                    "USE `verified_prices`. An estimator confirmed these against the "
                    "source document; the rows in `price_rows` came from the parser and "
                    "are superseded wherever the two disagree. Cite the override's "
                    "`source`, and honour its `price_basis` exactly as you would a "
                    "parsed row."),
                **payload,
            }
        return json.dumps(payload, indent=2)
    finally:
        con.close()


@mcp.tool()
def match_materials(catalog_id: str, requirements: list[str], per_item: int = 5) -> str:
    """Map a plan's material requirements onto real catalog products.

    This is the bridge tool: feed it the items you read off the drawings or
    specification (e.g. 'ADA tactile restroom signage', 'surface mounted soap
    dispenser', '4x4 ball bearing hinge US26D') and it returns candidate
    products for each, or an explicit no-match.

    `catalog_id` may be **""** to search every indexed catalog at once. With one
    price book per vendor that is the normal call: each candidate is labelled
    with the vendor carrying it, so one pass answers "who supplies this".

    A `matched: false` result is a real answer. Check whether it carries
    `found_in_page_text` (present but on unparsed pages) before reporting the
    item as unavailable - and never fill a gap from memory.
    """
    con = _con()
    try:
        where, args0, vendors = _scope(con, catalog_id)
        if where is None:
            return json.dumps({
                **EMPTY_SHELF,
                "results": [],
                "gaps": list(requirements),
                "hint": EMPTY_SHELF["hint"],
            })
        blurb = ("LOWER(section || ' ' || subsection || ' ' || "
                 "COALESCE(model,'') || ' ' || description)")
        total = con.execute("SELECT COUNT(DISTINCT model) FROM products "
                            "WHERE 1=1" + where, args0).fetchone()[0] or 1
        results, gaps = [], []
        for req in requirements:
            terms = [_stem(t) for t in re.findall(r"[A-Za-z0-9/]{3,}", req)
                     if t.lower() not in STOPWORDS]
            if not terms:
                continue
            # Which of the requirement's words actually distinguish anything?
            # "stainless", "steel" and "bar" describe a quarter of the shelf;
            # "grab", "partition" and "locker" decide. A product must hit at
            # least one distinguishing word to be a candidate at all - that is
            # what stops "metal lockers" matching every metal hinge in the book.
            # ponytail: rarity is counted per requirement, not precomputed. A few
            # LIKE scans over the products table; build an IDF table if the shelf
            # grows enough for that to show.
            rare = [t for t in terms if con.execute(
                f"SELECT COUNT(DISTINCT model) FROM products WHERE {blurb} LIKE ?"
                + where, [f"%{t}%"] + args0
            ).fetchone()[0] <= total * 0.10]

            # Rank on ALL the words, though. Scoring only the rare ones makes a
            # longer, more specific requirement match LESS than a short one:
            # "grab bar" found Bradley's grab bars while "36 inch stainless grab
            # bar" found nothing, because the extra words raised the bar and
            # "bar" itself had been discarded as generic.
            score = " + ".join(f"({blurb} LIKE ?)" for _ in terms)
            gate = (" + ".join(f"({blurb} LIKE ?)" for _ in rare)) if rare else score
            gate_args = [f"%{t}%" for t in (rare or terms)]
            need = 1 if rare else min(2, len(terms))
            div, csi, cname = ix.classify(req)

            def query(section, limit):
                """Best-scoring models, optionally confined to one CSI section.

                The section filter has to run in SQL, not on the rows that come
                back: "36 inch stainless grab bar" fills any LIMIT window with
                Hager push bars before a single grab bar appears, so filtering
                afterwards throws away every correct answer.
                """
                sq = " AND p.csi_section=?" if section else ""
                return con.execute(
                    "SELECT p.model, p.description, p.size, p.finish, p.list_price, "
                    "p.qty, p.disc_code, p.page, p.section, p.csi_section, p.csi_name, "
                    f"COUNT(*), MAX({score}) AS score, p.catalog_id, p.price_basis "
                    "FROM products p "
                    "WHERE p.model IS NOT NULL" + sq
                    + where.replace("catalog_id", "p.catalog_id") +
                    f" GROUP BY p.catalog_id, p.model HAVING MAX({gate}) >= ? "
                    "ORDER BY score DESC, p.model LIMIT ?",
                    [f"%{t}%" for t in terms] + ([section] if section else [])
                    + args0 + gate_args + [need, limit]).fetchall()

            try:
                # A requirement that names its own CSI section is not answered by
                # a product from a different one. ASI's "Toilet Tissue Dispenser
                # - Partition Mounted" shares both decisive words with "toilet
                # partition" and is still not a toilet partition.
                hits = query(csi, per_item * 6)
                off = [] if hits else (query(None, 3) if csi else [])
            except Exception as e:
                return json.dumps({"error": f"bad requirement {req!r}: {e}"})
            # keep only the best-scoring tier - the tail below it is noise
            hits = [h for h in hits if h[12] == hits[0][12]][:per_item] if hits else []
            cands = [{
                "vendor": vendors.get(h[13], ("?", "?"))[0],
                "catalog_id": h[13],
                "model": h[0], "description": h[1][:220], "example_size": h[2],
                "example_finish": h[3], "example_price": h[4],
                "example_list_price": h[4],          # kept for existing consumers
                "example_price_basis": h[14] if len(h) > 14 else "list",
                "already_net": (h[14] if len(h) > 14 else "list") in NET_BASES,
                "pack_qty": h[5], "page": h[7], "section": h[8],
                "csi_section": f"{h[9]} {h[10]}" if h[9] else None,
                "price_rows_for_model": h[11],
            } for h in hits]
            entry = {"requirement": req, "requirement_csi": f"{csi} {cname}" if csi else None,
                     "matched": bool(cands),
                     "vendors_carrying": sorted({c["vendor"] for c in cands}),
                     "candidates": cands}
            if not cands:
                # Absent from the product rows is not the same as absent from
                # the catalog: sections whose layout the row parser skips still
                # have their text indexed. Check there before calling it a gap.
                pages = con.execute(
                    "SELECT page, section, catalog_id FROM page_text WHERE "
                    "page_text MATCH ?" + where + " ORDER BY rank LIMIT 6",
                    # prefix match: terms are singular stems ("continuou"),
                    # while the page says "continuous"
                    [" AND ".join(f'"{t}"*' for t in terms)] + args0).fetchall()
                if pages:
                    entry["found_in_page_text"] = [
                        {"vendor": vendors.get(c, ("?", "?"))[0], "catalog_id": c,
                         "page": p, "section": s} for p, s, c in pages]
                    entry["action"] = (
                        "No parsed product row matches, but these pages mention "
                        "it - they use a layout the row parser does not read. "
                        "Call get_page on them and read the models and prices "
                        "from text_rows before concluding anything.")
                elif off:
                    entry["related_but_wrong_section"] = [{
                        "vendor": vendors.get(h[13], ("?", "?"))[0],
                        "model": h[0], "description": h[1][:160],
                        "csi_section": f"{h[9]} {h[10]}" if h[9] else None,
                    } for h in off]
                    entry["action"] = (
                        f"Products share wording with this requirement but sit in "
                        f"a different CSI section than {csi} {cname}. They are not "
                        "answers - a partition-mounted dispenser is not a "
                        "partition. Report this as not carried unless you have "
                        "checked one of them and it genuinely satisfies the "
                        "requirement.")
                    gaps.append(req)
                else:
                    entry["action"] = (
                        "Not in the searched catalogs at all - not in the product "
                        "rows and not in the page text. Record it as a gap to "
                        "source elsewhere. Do NOT invent a model number or price. "
                        "If you searched one catalog, retry with catalog_id=\"\" "
                        "before telling the user no vendor carries it.")
                    gaps.append(req)
            else:
                entry["next"] = (
                    f"lookup_product('{cands[0]['catalog_id']}', "
                    f"'{cands[0]['model']}') for the full size/finish price table.")
            results.append(entry)
        return json.dumps({
            "requirements": len(results),
            "searched": (f"catalog {catalog_id}" if catalog_id
                         else f"all {len(vendors)} indexed catalogs"),
            "unmatched": gaps,
            "results": results,
            "note": LIST_PRICE_NOTE,
            "reminder": ("Candidates are text matches, not specification "
                         "approvals. Confirm size, finish, handing and rating "
                         "against the drawing before you commit to a model."),
        }, indent=2)
    finally:
        con.close()


@mcp.tool()
def search_catalog(catalog_id: str, query: str, section: str = "", limit: int = 20) -> str:
    """Full-text search across every catalog page.

    Supports FTS5 syntax: quoted phrases, AND/OR/NOT, prefix*. Use for notes,
    exceptions, options and surcharges that are not price rows - and for the
    sections whose layout the row parser does not read.
    """
    con = _con()
    try:
        _cat(con, catalog_id)
        q = "SELECT page, section, snippet(page_text, 3, '<<', '>>', ' ... ', 20) " \
            "FROM page_text WHERE catalog_id=? AND page_text MATCH ?"
        args = [catalog_id, query]
        if section:
            q += " AND section LIKE ?"
            args.append(f"%{section}%")
        q += " ORDER BY rank LIMIT ?"
        args.append(limit)
        try:
            rows = con.execute(q, args).fetchall()
        except Exception as e:
            return json.dumps({"error": f"bad FTS query {query!r}: {e}"})
        return json.dumps({
            "query": query, "hits": len(rows),
            "results": [{"page": p, "section": s, "snippet": sn} for p, s, sn in rows],
            "next": "get_page(catalog_id, page) for the full readable page.",
        }, indent=2)
    finally:
        con.close()


@mcp.tool()
def get_page(catalog_id: str, page: int) -> str:
    """One catalog page as spatially ordered rows, with column breaks marked '|',
    plus any price rows parsed from it.

    Use for footnotes, option adders, length surcharges and fire ratings - the
    conditions that change a price and never make it into a product row.
    """
    con = _con()
    try:
        path, _, _, pages = _cat(con, catalog_id)
        if not 1 <= page <= pages:
            return json.dumps({"error": f"page {page} out of range 1-{pages}"})
        meta = con.execute(
            "SELECT section, subsection, cat_page FROM pages WHERE catalog_id=? "
            "AND page=?", (catalog_id, page)).fetchone()
        prods = con.execute(
            f"SELECT {PROD_COLS} FROM products WHERE catalog_id=? AND page=?",
            (catalog_id, page)).fetchall()

        # index_catalog already stored exactly these rows as page_text.body. Reopening
        # and re-parsing the PDF to rebuild them cost a full page extraction per call.
        # The PDF is still the fallback for a page indexed before this was written, or
        # one whose text was empty at index time.
        stored = con.execute(
            "SELECT body FROM page_text WHERE catalog_id=? AND page=? LIMIT 1",
            (catalog_id, page)).fetchone()
        if stored and stored[0]:
            rows = [line for line in stored[0].split("\n") if line.strip()]
        else:
            doc = fitz.open(path)
            try:
                rows = ix.page_rows(doc[page - 1])
            finally:
                doc.close()
        return json.dumps({
            "page": page, "section": meta[0], "subsection": meta[1],
            "printed_page_no": meta[2],
            "price_rows": [_prod_json(r) for r in prods],
            "text_rows": rows,
            "note": ("text_rows keep columns apart with '|'. If price_rows is "
                     "empty but text_rows show prices, this page uses a layout "
                     "the parser does not read - read them from text_rows and "
                     "keep each price with its own column heading."),
        }, indent=2)
    finally:
        con.close()


@mcp.tool()
def verify_facts(catalog_id: str, claims: list[str]) -> str:
    """Check that statements actually appear in this catalog. RUN THIS ON EVERY
    model number, item number, finish code and price BEFORE you report it.

    Each claim is matched verbatim (case/quote/separator-insensitive) against
    all indexed page text. A claim that comes back `verified: false` is not in
    this catalog: either you misread it or you supplied it from product
    knowledge. Do not report it.
    """
    con = _con()
    try:
        _cat(con, catalog_id)
        # Normalized once per catalog and cached across calls, rather than re-normalized
        # on every invocation of the tool the instructions say to run before reporting
        # anything. The scan itself stays exhaustive - see the note on _NORM_CACHE.
        blobs = ix.normalized_pages(con, catalog_id)
        results = []
        for claim in claims:
            q = ix.norm(claim)
            if not q:
                continue
            hits = [{"page": p, "section": s} for p, s, b in blobs if q in b]
            entry = {"claim": claim, "verified": bool(hits), "found_on": hits[:6]}
            if not hits:
                toks = [t for t in q.split() if len(t) > 2]
                near = []
                for p, s, b in blobs:
                    if not toks:
                        break
                    n = sum(1 for t in toks if t in b)
                    if n >= max(2, int(len(toks) * 0.6)):
                        near.append({"page": p, "section": s,
                                     "matched_words": f"{n}/{len(toks)}"})
                near.sort(key=lambda x: -int(x["matched_words"].split("/")[0]))
                entry["near_miss"] = near[:5]
                entry["action"] = ("NOT IN THIS CATALOG - do not report it. Re-read "
                                   "the page with get_page and use the catalog's "
                                   "exact wording and price, or drop the claim.")
            results.append(entry)
        bad = [r["claim"] for r in results if not r["verified"]]
        return json.dumps({"checked": len(results),
                           "verified": len(results) - len(bad),
                           "unverified": bad, "results": results}, indent=2)
    finally:
        con.close()


@mcp.tool()
def lookup_crossover(model: str, vendor: str = "") -> str:
    """Other manufacturers' equivalents for a model, from published crossover tables.

    Answers "the drawings specify a Bobrick B-2888 and we buy Gamco - what is the
    equivalent?". The mapping comes from the vendor's own printed crossover sheet.

    A crossover is NOT an approved substitution. It says two manufacturers consider
    these parts comparable; it does not say the specification allows a swap, that the
    sizes and finishes match, or that the GC has agreed. Present the specified product
    and the proposed equal side by side and let the estimator decide, and always confirm
    the equivalent actually exists with `lookup_product` before quoting it.
    """
    con = _con()
    try:
        needle = " ".join(model.strip().upper().split())
        if not needle:
            return json.dumps({"error": "model is required"})
        classes = [c for (c,) in con.execute(
            "SELECT DISTINCT class_id FROM crossovers WHERE UPPER(model)=?", (needle,))]
        if not classes and len(needle) > 3:
            classes = [c for (c,) in con.execute(
                "SELECT DISTINCT class_id FROM crossovers WHERE UPPER(model) LIKE ? "
                "LIMIT 25", (f"%{needle}%",))]
        if not classes:
            return json.dumps({
                "model": model, "found": False, "equivalents": [],
                "action": ("No crossover table on this shelf maps that model. Do not "
                           "invent an equivalent - use match_materials to find a "
                           "comparable product by description, and raise it as a "
                           "substitution for approval."),
            }, indent=2)

        placeholders = ", ".join("?" for _ in classes)
        rows = con.execute(
            f"SELECT class_id, vendor, model, sheet FROM crossovers "
            f"WHERE class_id IN ({placeholders}) ORDER BY class_id, vendor", classes)
        grouped = {}
        for class_id, vend, mdl, sheet in rows:
            grouped.setdefault(class_id, {"source_sheet": sheet, "members": []})
            grouped[class_id]["members"].append({"vendor": vend, "model": mdl})

        out = []
        for group in grouped.values():
            members = group["members"]
            asked = [m for m in members if m["model"].upper() == needle]
            equivalents = [m for m in members if m["model"].upper() != needle]
            if vendor:
                want = " ".join(vendor.strip().upper().split())
                equivalents = [m for m in equivalents if want in m["vendor"]]
            if equivalents:
                out.append({"matched": asked or members[:1],
                            "equivalents": equivalents,
                            "source_sheet": group["source_sheet"]})

        return json.dumps({
            "model": model,
            "found": bool(out),
            "crossovers": out,
            "note": ("A published crossover, not an approved substitution. Confirm the "
                     "equivalent with lookup_product, check size, finish and rating "
                     "against the drawing, and present it as a proposed equal."),
        }, indent=2, default=str)
    finally:
        con.close()


@mcp.tool()
def record_price_override(
    vendor: str,
    model: str,
    price: float,
    price_basis: str,
    source: str,
    size: str = "",
    finish: str = "",
    confirmed_by: str = "",
    effective_date: str = "",
    note: str = "",
) -> str:
    """Record a price an estimator has CONFIRMED against the source document.

    Use this when a parsed price is wrong, or when a price lives somewhere the parser
    cannot read (a finish matrix, a per-foot formula, a vendor quote, a spreadsheet
    column nobody indexed). From then on `lookup_product` returns it ahead of the
    parsed rows for that model.

    `price_basis` must say WHAT the number is - `list`, `net`, `distributor_net`,
    `dealer`, `hamilton_parker_net`. A net basis is already a cost and no multiplier
    may be applied to it.

    `source` is required and is the audit trail: name the page, the quote number or the
    person. Do not record a price you have not verified - this file outranks the
    catalog, so a wrong entry here is worse than a wrong parse.

    Leave `size` / `finish` empty to cover every variant of the model.
    """
    try:
        saved = ov.record({
            "vendor": vendor, "model": model, "price": price,
            "price_basis": price_basis, "source": source, "size": size,
            "finish": finish, "confirmed_by": confirmed_by,
            "effective_date": effective_date, "note": note,
        })
    except ValueError as exc:
        return json.dumps({"error": str(exc)}, indent=2)
    return json.dumps({
        "recorded": saved,
        "file": ov.path(),
        "note": ("Stored in memory/, not in the rebuildable index cache, so it survives "
                 "a re-index. It now outranks the parsed rows for this model."),
    }, indent=2)


@mcp.tool()
def list_price_overrides(vendor: str = "", model: str = "") -> str:
    """Every estimator-verified price on file, newest first. Filter by vendor or model.

    Read this before trusting a parsed price for a vendor whose book is known to parse
    badly - and before recording a new override, to see whether one already exists.
    """
    # Same ordering rule as `for_model`: newest first, with file position breaking a
    # timestamp tie, so the listing agrees with what a lookup would actually use.
    rows = list(enumerate(ov.load()))
    if vendor:
        rows = [(i, r) for i, r in rows if ov._norm(r.get("vendor")) == ov._norm(vendor)]
    if model:
        rows = [(i, r) for i, r in rows if ov._norm(r.get("model")) == ov._norm(model)]
    rows = [r for _, r in sorted(
        rows, key=lambda pair: (pair[1].get("recorded_at") or "", pair[0]), reverse=True)]
    return json.dumps({
        "file": ov.path(),
        "count": len(rows),
        "overrides": rows,
        "note": ("These outrank the parsed catalog rows. Where two entries cover the "
                 "same model, the most recently recorded one wins."),
    }, indent=2)


def main():
    asyncio.run(mcp.run_stdio_async())


if __name__ == "__main__":
    main()
