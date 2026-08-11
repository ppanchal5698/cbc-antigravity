"""building-plan-intelligence MCP server.

Serves text and pixels from architectural plan sets. It owns no model: the
calling IDE's own LLM/VLM does the reading. Sheets whose text was converted to
vector outlines can only be read by vision, so this server renders them as
readable tiles and lets the caller write back what it read.
"""

import asyncio
import base64
import json
import time

import fitz
from mcp.server.mcpserver import MCPServer
from mcp.types import ImageContent

from . import index as ix

mcp = MCPServer(
    name="building-plan-intelligence",
    instructions=(
        "Reads architectural/engineering plan sets (PDF).\n"
        "WORKFLOW: 1) open_plan_set(pdf_path) -> doc_id. 2) plan_overview(doc_id). "
        "3) list_sheets / search_sheets to locate. 4) read_schedule for ANY table; "
        "get_sheet/read_layout for notes. 5) render_sheet + record_vision_reading "
        "for sheets whose vision_need is 'full', 'identity' or 'drawing'. "
        "find_schedule(doc_id, kind) locates a schedule by CONTENT - never guess a "
        "sheet number, numbering differs between firms. "
        "6) verify_facts on every claim before you answer.\n"
        "FOUR RULES THAT PREVENT WRONG ANSWERS:\n"
        "1. Schedules: always read_schedule, never flat text. Sheet text interleaves "
        "columns from unrelated tables, which silently pairs values with the wrong "
        "row and hides whole rows.\n"
        "2. Enumerate: count the rows a schedule returns and report every one. "
        "Numbering skips (01,02,03,06) - never assume a range is contiguous.\n"
        "2b. A schedule that states no quantity or no size does not mean one each of a "
        "standard size - the number is on the plan or the elevation. Read it there with "
        "render_sheet, or report it as unread. Never default a quantity to 1.\n"
        "3. Cross-check: run cross_reference on every manufacturer/model/product. "
        "Spec sheets and drawing schedules often disagree; report the conflict "
        "rather than picking one.\n"
        "4. Verify: run verify_facts on every model number, dimension, finish, "
        "quantity and quoted string before reporting. Anything unverified is not in "
        "the document - drop it. Never supply a detail from product knowledge.\n"
        "A 36x24in sheet rendered whole is unreadable (body text ~5px); "
        "render_sheet tiles it so text lands at ~16px. Raise cols/rows, not dpi."
    ),
)

DEFAULT_DPI = 150
DEFAULT_COLS, DEFAULT_ROWS = 3, 2

# find_schedule reads tables on the best few candidates, never the whole document: a
# full-set scan measured 197s (Dutch Bros, 65 sheets) and 202s (Baldwin, 87) and returned
# 566 and 379 tables respectively, because every title block and revision block is a ruled
# grid. Typical sheets take 0.4-2.8s; a pathological one takes 25-31s, hence the budget.
MAX_SCHEDULE_CANDIDATES = 3
SCHEDULE_TABLE_BUDGET_S = 12.0

# A tile should land body text at ~16px. 36x24 wants 3x2; a small sheet needs fewer.
TILE_TARGET_IN = 12.0


def _con():
    return ix.connect()


def _doc_row(con, doc_id):
    row = con.execute("SELECT path, pages FROM docs WHERE doc_id=?", (doc_id,)).fetchone()
    if not row:
        raise ValueError(f"unknown doc_id {doc_id!r}; call open_plan_set first")
    return row


@mcp.tool()
def open_plan_set(pdf_path: str) -> str:
    """Index a plan set PDF and return its doc_id plus a summary.

    Cached by file mtime/size - calling it again on an unchanged file is cheap.
    Always call this first; every other tool takes the doc_id it returns.
    """
    con = _con()
    try:
        doc_id, built = ix.index_doc(pdf_path, con)
        path, pages = _doc_row(con, doc_id)
        disc = con.execute(
            "SELECT discipline, COUNT(*) FROM sheets WHERE doc_id=? "
            "GROUP BY discipline ORDER BY 2 DESC", (doc_id,)).fetchall()
        need = dict(con.execute(
            "SELECT vision_need, COUNT(*) FROM sheets WHERE doc_id=? "
            "GROUP BY vision_need", (doc_id,)).fetchall())
        size = con.execute(
            "SELECT width_in, height_in FROM sheets WHERE doc_id=? LIMIT 1",
            (doc_id,)).fetchone()
        return json.dumps({
            "doc_id": doc_id,
            "path": path,
            "pages": pages,
            "newly_indexed": built,
            "sheet_size_in": f"{size[0]}x{size[1]}" if size else None,
            "disciplines": {d: n for d, n in disc},
            "vision_need": {
                "none": need.get("none", 0),
                "identity": need.get("identity", 0),
                "drawing": need.get("drawing", 0),
                "full": need.get("full", 0),
            },
            "hint": ("'full' - no text layer at all. 'identity' - searchable but the "
                     "title block was outlined, so the sheet is unnamed. 'drawing' - "
                     "extracted and named, but what it means is geometry: tag counts, "
                     "sizes and locations are not in the text layer. All three need "
                     "render_sheet + record_vision_reading before a quantity is taken "
                     "off them. Use find_schedule to locate a schedule by content - "
                     "sheet numbering differs between firms."),
        }, indent=2)
    finally:
        con.close()


@mcp.tool()
def list_sheets(doc_id: str, discipline: str = "", vision_need: str = "") -> str:
    """List the sheet index: sheet number, title, page, discipline.

    Filter by discipline (e.g. 'Architectural') or by vision_need
    ('none' | 'identity' | 'drawing' | 'full') to find sheets still unread.
    """
    con = _con()
    try:
        _doc_row(con, doc_id)
        q = ("SELECT page, sheet_no, title, discipline, confidence, vision_need "
             "FROM sheets WHERE doc_id=?")
        args = [doc_id]
        if discipline:
            q += " AND discipline LIKE ?"
            args.append(f"%{discipline}%")
        if vision_need:
            q += " AND vision_need=?"
            args.append(vision_need)
        q += " ORDER BY page"
        rows = con.execute(q, args).fetchall()
        return json.dumps([
            {"page": p, "sheet": s, "title": t, "discipline": d,
             "source": c, "vision_need": v}
            for p, s, t, d, c, v in rows], indent=2)
    finally:
        con.close()


@mcp.tool()
def get_sheet(doc_id: str, sheet: str) -> str:
    """Overview of one sheet: title block, plus its text in READING ORDER.

    `sheet` accepts a sheet number ('A2.0') or a page number ('13').

    For any schedule or table on this sheet use `read_schedule` instead — the
    flat text here cannot be trusted to keep a value with its own row.
    """
    con = _con()
    try:
        path, _ = _doc_row(con, doc_id)
        page = ix.resolve_page(con, doc_id, sheet)
        if page is None:
            return json.dumps({
                "error": f"no sheet or page matching {sheet!r}",
                "did_you_mean": ix.near_misses(con, doc_id, sheet),
                "hint": "Sheet numbering differs between firms. Use find_schedule to "
                        "locate a schedule by content instead of guessing a number.",
            })
        r = con.execute(
            "SELECT page, sheet_no, title, discipline, confidence, vision_need, "
            "width_in, height_in, tb_json FROM sheets WHERE doc_id=? AND page=?",
            (doc_id, page)).fetchone()
        vision = con.execute(
            "SELECT source, body FROM sheet_text WHERE doc_id=? AND page=? "
            "AND source!='pdf'", (doc_id, page)).fetchall()

        doc = fitz.open(path)
        try:
            pg = doc[page - 1]
            rows = ix.layout_rows(pg)
            n_tables = len(ix.page_tables(pg))
        finally:
            doc.close()

        out = {
            "page": r[0], "sheet": r[1], "title": r[2], "discipline": r[3],
            "source": r[4], "vision_need": r[5],
            "size_in": f"{r[6]}x{r[7]}",
            "title_block": json.loads(r[8] or "{}"),
            "tables_on_sheet": n_tables,
            "text_rows": rows,
        }
        if vision:
            out["vision_text"] = {src: body for src, body in vision}
        if n_tables:
            out["warning"] = (
                f"{n_tables} table(s) detected on this sheet. Do NOT read schedule "
                "values out of text_rows — call read_schedule(doc_id, sheet) so each "
                "value stays attached to its own row.")
        return json.dumps(out, indent=2)
    finally:
        con.close()


@mcp.tool()
def read_schedule(doc_id: str, sheet: str, region: str = "") -> str:
    """Read the SCHEDULES/TABLES on a sheet as real rows. Use this for ANY
    schedule: door, window, hardware, equipment, finish, fixture, panel.

    Never read a schedule from `get_sheet` text — on a plan sheet that text
    interleaves columns from unrelated tables, so values get paired with the
    wrong row and whole rows disappear. This tool recovers the ruled grid.

    region: optional 'x0,y0,x1,y1' in inches to limit to one table.
    """
    con = _con()
    try:
        path, _ = _doc_row(con, doc_id)
        page_no = ix.resolve_page(con, doc_id, sheet)
        if page_no is None:
            return json.dumps({
                "error": f"no sheet or page matching {sheet!r}",
                "did_you_mean": ix.near_misses(con, doc_id, sheet),
                "hint": "Sheet numbering differs between firms. Use find_schedule to "
                        "locate a schedule by content instead of guessing a number.",
            })
        doc = fitz.open(path)
        try:
            page = doc[page_no - 1]
            clip = None
            if region:
                try:
                    x0, y0, x1, y1 = [float(v) * 72 for v in region.split(",")]
                    clip = fitz.Rect(x0, y0, x1, y1)
                except ValueError:
                    return json.dumps({"error": "region must be 'x0,y0,x1,y1' in inches"})
            tables = ix.page_tables(page, clip)
            return json.dumps({
                "page": page_no,
                "tables_found": len(tables),
                "tables": tables,
                "note": ("Each table is a list of rows. Count the rows and report "
                         "every one — a schedule with 4 rows has 4 entries, and "
                         "row numbering may skip (01, 02, 03, 06). If a table you "
                         "expected is missing, it may be unruled: fall back to "
                         "read_layout on that region, or render_sheet and read it."),
            }, indent=2)
        finally:
            doc.close()
    finally:
        con.close()


@mcp.tool()
def read_layout(doc_id: str, sheet: str, region: str = "") -> str:
    """Sheet text as spatially-ordered rows, with column breaks marked by '|'.

    Use for notes, legends and unruled tables that `read_schedule` did not
    catch. Preserves what is on the same line and what is in a different
    column — unlike `get_sheet` text, which is spatially scrambled.

    region: optional 'x0,y0,x1,y1' in inches.
    """
    con = _con()
    try:
        path, _ = _doc_row(con, doc_id)
        page_no = ix.resolve_page(con, doc_id, sheet)
        if page_no is None:
            return json.dumps({
                "error": f"no sheet or page matching {sheet!r}",
                "did_you_mean": ix.near_misses(con, doc_id, sheet),
                "hint": "Sheet numbering differs between firms. Use find_schedule to "
                        "locate a schedule by content instead of guessing a number.",
            })
        doc = fitz.open(path)
        try:
            page = doc[page_no - 1]
            clip = None
            if region:
                try:
                    x0, y0, x1, y1 = [float(v) * 72 for v in region.split(",")]
                    clip = fitz.Rect(x0, y0, x1, y1)
                except ValueError:
                    return json.dumps({"error": "region must be 'x0,y0,x1,y1' in inches"})
            rows = ix.layout_rows(page, clip)
            return json.dumps({"page": page_no, "rows": rows}, indent=2)
        finally:
            doc.close()
    finally:
        con.close()


@mcp.tool()
def verify_facts(doc_id: str, claims: list[str]) -> str:
    """Check that statements actually appear in the document. RUN THIS ON EVERY
    factual claim — model number, dimension, finish, quantity, quoted text —
    BEFORE you report it.

    Each claim is matched verbatim (whitespace/case/quote-insensitive) against
    all indexed text. A claim that comes back `verified: false` is not in this
    document: either you misread it or you supplied it from memory. Do not
    report it. Check `near_miss` — it shows sheets containing most of the words,
    which is usually where the real wording differs from what you wrote.
    """
    con = _con()
    try:
        _doc_row(con, doc_id)
        meta = {p: (s, t) for p, s, t in con.execute(
            "SELECT page, sheet_no, title FROM sheets WHERE doc_id=?", (doc_id,))}
        # Normalized once per document and cached across calls, rather than
        # re-normalized on every invocation of the tool the instructions say to run on
        # every claim. The scan itself stays exhaustive - see the note on _NORM_CACHE.
        blobs = ix.normalized_sheets(con, doc_id)

        results = []
        for claim in claims:
            q = ix.norm(claim)
            if not q:
                continue
            hits = [{"page": p, "sheet": meta.get(p, (None, None))[0], "found_in": src}
                    for p, src, b in blobs if q in b]

            # WHERE a claim was found decides what it is worth, and the two are not the
            # same kind of evidence. `pdf` is text this document carries. Anything else
            # was written by `record_vision_reading` - a model's transcription of a
            # rendered tile, saved back into the index.
            #
            # That still verifies, and must: on a sheet whose text was outlined to vectors
            # it is the ONLY evidence that can ever exist, and reporting it as unverified
            # would have the rules order a correctly-read fact deleted. What it cannot do
            # is corroborate the reader who wrote it. A hallucinated model number recorded
            # during a vision pass used to come back indistinguishable from one printed in
            # the document, and stayed that way for the life of the index.
            from_doc = [h for h in hits if h["found_in"] == "pdf"]
            from_vision = [h for h in hits if h["found_in"] != "pdf"]
            entry = {
                "claim": claim,
                "verified": bool(hits),
                "verified_by": ("both" if from_doc and from_vision else
                                "document" if from_doc else
                                "vision_reading" if from_vision else "nothing"),
                "found_on": hits[:6],
            }
            if from_vision and not from_doc:
                entry["caution"] = (
                    "Found ONLY in a vision reading - text a model wrote back after "
                    "looking at a rendered tile, not text this document carries. On a "
                    "sheet with no text layer that is the best evidence available and it "
                    "stands, but it is not independent of the reader: it cannot be the "
                    "sole support for a model number, dimension, finish or price. Cite it "
                    "[drawing], never [schedule], and say it was read by eye.")
            if not hits:
                toks = [t for t in q.split() if len(t) > 2]
                near = []
                for p, src, b in blobs:
                    if not toks:
                        break
                    n = sum(1 for t in toks if t in b)
                    if n >= max(2, int(len(toks) * 0.6)):
                        near.append({"page": p, "sheet": meta.get(p, (None, None))[0],
                                     "matched_words": f"{n}/{len(toks)}"})
                near.sort(key=lambda x: -int(x["matched_words"].split("/")[0]))
                entry["near_miss"] = near[:5]
                entry["action"] = ("NOT IN DOCUMENT — do not report this. Re-read the "
                                   "sheet with read_schedule/read_layout and use the "
                                   "document's exact wording, or drop the claim.")
            results.append(entry)
        bad = [r["claim"] for r in results if not r["verified"]]
        vision_only = [r["claim"] for r in results if r["verified_by"] == "vision_reading"]
        out = {
            "checked": len(results),
            "verified": len(results) - len(bad),
            "unverified": bad,
            "verified_only_by_vision_reading": vision_only,
            "results": results,
        }
        if vision_only:
            out["note"] = (
                f"{len(vision_only)} claim(s) are supported only by what a vision pass "
                "wrote back, not by text this document carries. That is legitimate for an "
                "outlined sheet and is how a vision-only sheet is ever quoted at all - but "
                "tag those facts [drawing], not [schedule], and do not let one stand alone "
                "behind a model number or a price.")
        return json.dumps(out, indent=2)
    finally:
        con.close()


@mcp.tool()
def cross_reference(doc_id: str, term: str, context: int = 130) -> str:
    """Show EVERY mention of a term across the whole set, grouped by sheet.

    Specifications and schedules disagree in real plan sets — a spec sheet may
    name one product series and the schedule on a drawing another. Run this
    before reporting any manufacturer, model or product, and report a conflict
    as a conflict instead of silently picking one.
    """
    con = _con()
    try:
        _doc_row(con, doc_id)
        q = ix.norm(term)
        rows = con.execute(
            "SELECT page, source, body FROM sheet_text WHERE doc_id=?", (doc_id,)).fetchall()
        meta = {p: (s, t, d) for p, s, t, d in con.execute(
            "SELECT page, sheet_no, title, discipline FROM sheets WHERE doc_id=?", (doc_id,))}
        out = []
        for page, source, body in rows:
            nb = ix.norm(body)
            start = 0
            snippets = []
            while True:
                i = nb.find(q, start)
                if i < 0:
                    break
                snippets.append(nb[max(0, i - context): i + len(q) + context].strip())
                start = i + len(q)
                if len(snippets) >= 6:
                    break
            if snippets:
                s, t, d = meta.get(page, (None, None, None))
                out.append({"page": page, "sheet": s, "title": t, "discipline": d,
                            "found_in": source, "mentions": len(snippets),
                            "context": snippets})
        return json.dumps({
            "term": term,
            "sheets_mentioning": len(out),
            "total_mentions": sum(o["mentions"] for o in out),
            "results": out,
            "note": ("Compare the wording across sheets. If two sheets state "
                     "different values for the same thing, report BOTH and flag "
                     "the discrepancy — do not choose one."),
        }, indent=2)
    finally:
        con.close()


@mcp.tool()
def search_sheets(doc_id: str, query: str, limit: int = 20) -> str:
    """Full-text search across the whole set, including text recorded by vision.

    Supports FTS5 syntax: quoted phrases, AND/OR/NOT, prefix*.
    Returns the matching sheets with snippets.
    """
    con = _con()
    try:
        _doc_row(con, doc_id)
        try:
            rows = con.execute(
                "SELECT t.page, t.source, snippet(sheet_text, 3, '<<', '>>', ' ... ', 18) "
                "FROM sheet_text t WHERE t.doc_id=? AND sheet_text MATCH ? "
                "ORDER BY rank LIMIT ?", (doc_id, query, limit)).fetchall()
        except Exception as e:
            return json.dumps({"error": f"bad FTS query {query!r}: {e}"})
        out = []
        for page, source, snip in rows:
            meta = con.execute(
                "SELECT sheet_no, title, discipline FROM sheets "
                "WHERE doc_id=? AND page=?", (doc_id, page)).fetchone()
            out.append({"page": page, "sheet": meta[0], "title": meta[1],
                        "discipline": meta[2], "found_in": source,
                        "snippet": snip})
        return json.dumps({"query": query, "hits": len(out), "results": out}, indent=2)
    finally:
        con.close()


@mcp.tool()
def find_schedule(doc_id: str, kind: str = "door", read_tables: bool = True) -> str:
    """Find a schedule by WHAT IT SAYS, not where it sits. Start every takeoff here.

    Sheet numbering is a per-firm convention: the door schedule is on A2.2 in one set and
    page 31 of the next, and 60% of some sets have no parseable sheet number at all. This
    ranks every sheet by how much of the kind's vocabulary it carries, then reads tables on
    the best candidates only - a whole-document table scan costs ~200s and finds 500+
    tables, because title blocks and revision blocks are ruled grids too.

    kind: door | hardware | accessory | finish | window | room | equipment | partition

    ALWAYS read `not_searchable` before concluding a schedule is absent. A sheet whose text
    was outlined to vectors is invisible to search until it has been rendered and read, so
    zero hits with a non-zero not_searchable means "look at those sheets", NOT "no such
    schedule exists". Pass the winning sheet to read_schedule for the full table.
    """
    kinds = sorted(ix.SCHEDULE_VOCAB)
    terms = ix.SCHEDULE_VOCAB.get(kind.strip().lower())
    if not terms:
        return json.dumps({"error": f"unknown kind {kind!r}", "kinds": kinds})

    con = _con()
    try:
        _doc_row(con, doc_id)
        # One OR query over quoted phrases: FTS ranks, we count per-sheet hits to break ties.
        query = " OR ".join(f'"{t}"' for t in terms)
        try:
            rows = con.execute(
                "SELECT page, source, body FROM sheet_text "
                "WHERE doc_id=? AND sheet_text MATCH ? LIMIT 60",
                (doc_id, query)).fetchall()
        except Exception as e:
            return json.dumps({"error": f"FTS query failed: {e}"})

        scored = {}
        for page, source, body in rows:
            low = (body or "").lower()
            hits = sum(low.count(t) for t in terms)
            matched = sorted({t for t in terms if t in low})
            prev = scored.get(page)
            if not prev or hits > prev["hits"]:
                scored[page] = {"page": page, "hits": hits, "matched": matched,
                                "found_in": source}
        # Rank on DISTINCT vocabulary matched, then raw count. A real schedule uses the
        # whole column vocabulary once each ("door no", "door type", "frame type",
        # "door schedule"); a detail sheet repeats one phrase in callouts that say "SEE
        # DOOR SCHEDULE". Counting occurrences ranks the reference above the schedule -
        # measured on Dutch Bros, where A8.1 DETAILS scored 8 hits from 2 phrases and beat
        # the actual door schedule on A2.2 with 6 hits from 4.
        ranked = sorted(scored.values(),
                        key=lambda r: (-len(r["matched"]), -r["hits"], r["page"]))

        for cand in ranked:
            meta = con.execute(
                "SELECT sheet_no, title, discipline, vision_status FROM sheets "
                "WHERE doc_id=? AND page=?", (doc_id, cand["page"])).fetchone()
            if meta:
                cand.update(sheet=meta[0], title=meta[1], discipline=meta[2],
                            vision_status=meta[3])

        # Two different kinds of blindness, and both have to be zero before absence means
        # anything. A sheet with no indexed text is invisible to search outright; a sheet
        # that extracted fine but has never been looked at can still hold a schedule drawn
        # as outlined text or readable only as geometry.
        blind = con.execute(
            "SELECT page FROM sheets s WHERE s.doc_id=? "
            "AND NOT EXISTS (SELECT 1 FROM sheet_text t WHERE t.doc_id=s.doc_id "
            "AND t.page=s.page) ORDER BY page", (doc_id,)).fetchall()
        placeholders = ",".join("?" * len(ix.OUT_OF_SCOPE_DISCIPLINES))
        unread = con.execute(
            f"SELECT page FROM sheets WHERE doc_id=? AND vision_status='required' "
            f"AND discipline NOT IN ({placeholders}) ORDER BY page",
            (doc_id, *ix.OUT_OF_SCOPE_DISCIPLINES)).fetchall()

        out = {
            "kind": kind, "kinds": kinds, "vocabulary": terms,
            "candidates": ranked[:8],
            "not_searchable": {
                "count": len(blind),
                "pages": [b[0] for b in blind[:20]],
                "meaning": "These sheets have no indexed text at all - search cannot see "
                           "them. render_sheet + record_vision_reading before concluding "
                           "this schedule is not in the set.",
            },
            "unread_drawings": {
                "count": len(unread),
                "pages": [u[0] for u in unread[:20]],
                "meaning": "These sheets extracted text but have never been looked at. A "
                           "schedule drawn as outlined text, or a count that only exists "
                           "as tags, is not in the search index.",
            },
        }

        # Tables from the top candidates only, and never a whole-document scan.
        if read_tables and ranked:
            path, _ = _doc_row(con, doc_id)
            doc = fitz.open(path)
            try:
                for cand in ranked[:MAX_SCHEDULE_CANDIDATES]:
                    t0 = time.time()
                    tables = ix.page_tables(doc[cand["page"] - 1])
                    cand["tables"] = tables
                    cand["tables_found"] = len(tables)
                    # One pathological sheet must not hang a takeoff. Later candidates
                    # keep their ranking; the caller can read_schedule them directly.
                    if time.time() - t0 > SCHEDULE_TABLE_BUDGET_S:
                        cand["note"] = "slow sheet; remaining candidates not table-read"
                        break
            finally:
                doc.close()

        if not ranked:
            unseen = len(blind) + len(unread)
            out["absence_established"] = unseen == 0
            out["next_step"] = (
                f"No sheet mentions the {kind} vocabulary. "
                + (f"This is NOT evidence the schedule is absent: {len(blind)} sheet(s) "
                   f"have no text at all and {len(unread)} have never been looked at. "
                   "render_sheet + record_vision_reading those, then search again."
                   if unseen else
                   "Every sheet is searchable and every drawing has been read, so this set "
                   f"genuinely does not carry a {kind} schedule. Report it with a gap tag - "
                   "and check whether the requirement is stated as keynotes or in the "
                   "specification instead, which is common for Division 10.")
            )
        return json.dumps(out, indent=2, default=str)
    finally:
        con.close()


TILE_OVERLAP = 0.06  # callouts sit at tile edges; without overlap they get cut mid-word


def _tiles(rect, cols, rows):
    w, h = rect.width / cols, rect.height / rows
    ox, oy = w * TILE_OVERLAP, h * TILE_OVERLAP
    out = {}
    for r in range(rows):
        for c in range(cols):
            out[f"r{r + 1}c{c + 1}"] = fitz.Rect(
                max(rect.x0, rect.x0 + c * w - ox),
                max(rect.y0, rect.y0 + r * h - oy),
                min(rect.x1, rect.x0 + (c + 1) * w + ox),
                min(rect.y1, rect.y0 + (r + 1) * h + oy))
    return out


@mcp.tool()
def render_sheet(doc_id: str, sheet: str, tile: str = "", dpi: int = DEFAULT_DPI,
                 cols: int = 0, rows: int = 0,
                 region: str = "") -> list:
    """Render a sheet as image tiles for your vision model to read.

    A 36x24in sheet rendered whole is unreadable (9pt notes land at ~5px after
    downsampling). Split into a 3x2 grid the same text lands at ~16px.

    cols/rows default to 0, meaning "work it out from this sheet's real size" - plan sets
    are not all 36x24, and a fixed 3x2 over-tiles a small sheet and under-tiles a large one.
    Pass explicit values to override.

    tile:   '' returns every tile in the grid; 'r1c2' returns just that one.
    region: 'x0,y0,x1,y1' in inches from the top-left, to zoom a detail.
            Overrides tile.
    Raise `cols`/`rows` (not dpi) if text is still too small to read.
    """
    con = _con()
    try:
        path, _ = _doc_row(con, doc_id)
        page_no = ix.resolve_page(con, doc_id, sheet)
        if page_no is None:
            hits = ", ".join(m["sheet"] for m in ix.near_misses(con, doc_id, sheet))
            return [{"type": "text", "text": f"no sheet or page matching {sheet!r}"
                     + (f"; this set numbers sheets like: {hits}" if hits else "")}]
        doc = fitz.open(path)
        try:
            page = doc[page_no - 1]
            if region:
                try:
                    x0, y0, x1, y1 = [float(v) * 72 for v in region.split(",")]
                except ValueError:
                    return [{"type": "text",
                             "text": "region must be 'x0,y0,x1,y1' in inches"}]
                targets = {"region": fitz.Rect(x0, y0, x1, y1)}
            else:
                # Tile to a readable span rather than a fixed grid: a 36x24 sheet lands on
                # 3x2 as before, an 11x17 detail sheet on 1x2 instead of being cut into six.
                auto_c = max(1, round(page.rect.width / 72 / TILE_TARGET_IN))
                auto_r = max(1, round(page.rect.height / 72 / TILE_TARGET_IN))
                grid = _tiles(page.rect, max(1, cols or auto_c), max(1, rows or auto_r))
                if tile:
                    if tile not in grid:
                        return [{"type": "text",
                                 "text": f"tile {tile!r} not in grid; have {sorted(grid)}"}]
                    targets = {tile: grid[tile]}
                else:
                    targets = grid

            out = []
            for name, clip in targets.items():
                pix = page.get_pixmap(dpi=dpi, clip=clip)
                out.append({"type": "text",
                            "text": f"page {page_no} tile {name} ({pix.width}x{pix.height}px)"})
                out.append(ImageContent(
                    type="image",
                    data=base64.b64encode(pix.tobytes("png")).decode(),
                    mimeType="image/png"))
            return out
        finally:
            doc.close()
    finally:
        con.close()


@mcp.tool()
def record_vision_reading(doc_id: str, sheet: str, text: str, tile: str = "") -> str:
    """Save what your vision model read off a sheet so it becomes searchable.

    Call this after reading render_sheet tiles, especially for sheets whose
    vision_need is 'full' or 'identity'. Pass `sheet_no=A2.0` style text if you
    identified the sheet number, and it will fill in a missing identity.
    """
    con = _con()
    try:
        _doc_row(con, doc_id)
        page = ix.resolve_page(con, doc_id, sheet)
        if page is None:
            return json.dumps({
                "error": f"no sheet or page matching {sheet!r}",
                "did_you_mean": ix.near_misses(con, doc_id, sheet),
                "hint": "Sheet numbering differs between firms. Use find_schedule to "
                        "locate a schedule by content instead of guessing a number.",
            })
        label = f"vision:{tile}" if tile else "vision"
        con.execute("DELETE FROM sheet_text WHERE doc_id=? AND page=? AND source=?",
                    (doc_id, page, label))
        con.execute("INSERT INTO sheet_text (doc_id,page,source,body) VALUES (?,?,?,?)",
                    (doc_id, page, label, text))

        # let the caller resolve an unknown sheet number by writing it back
        found = None
        for tok in ("sheet_no=", "sheet no=", "sheet number="):
            if tok in text.lower():
                after = text.lower().split(tok, 1)[1].split()[0].strip(",;:'\"")
                cand = after.upper()
                if ix.SHEET_RX.match(cand):
                    found = cand
                break
        cur = con.execute("SELECT sheet_no, vision_need FROM sheets "
                          "WHERE doc_id=? AND page=?", (doc_id, page)).fetchone()
        if found and not cur[0]:
            con.execute("UPDATE sheets SET sheet_no=?, discipline=?, "
                        "confidence='vision' WHERE doc_id=? AND page=?",
                        (found, ix.discipline_of(found), doc_id, page))
        # vision_need drops to 'none' because the gap is now filled; vision_status becomes
        # 'recorded' so a later phase gate can tell "a drawing that was read" apart from
        # "a drawing nobody ever needed to read".
        con.execute("UPDATE sheets SET vision_need='none', vision_status='recorded' "
                    "WHERE doc_id=? AND page=?", (doc_id, page))
        con.commit()
        # This document's text just changed without its file changing, so verify_facts'
        # normalized cache is now a pre-vision snapshot. Drop it, or the very claims this
        # reading was taken to confirm come back verified: false.
        ix.invalidate_norm_cache(doc_id)
        return json.dumps({"page": page, "recorded_chars": len(text),
                           "sheet_no_set": found, "vision_need": "none",
                           "vision_status": "recorded"})
    finally:
        con.close()


@mcp.tool()
def plan_overview(doc_id: str) -> str:
    """Disciplines present, sheet ranges, and what still needs a vision pass."""
    con = _con()
    try:
        path, pages = _doc_row(con, doc_id)
        out = {"doc_id": doc_id, "path": path, "pages": pages, "disciplines": []}
        for (d,) in con.execute(
                "SELECT DISTINCT discipline FROM sheets WHERE doc_id=? "
                "ORDER BY discipline", (doc_id,)):
            rows = con.execute(
                "SELECT page, sheet_no, title FROM sheets WHERE doc_id=? AND "
                "discipline=? ORDER BY page", (doc_id, d)).fetchall()
            out["disciplines"].append({
                "discipline": d,
                "sheets": len(rows),
                "pages": f"{rows[0][0]}-{rows[-1][0]}",
                "examples": [r[1] or f"p{r[0]}" for r in rows[:6]],
            })
        for need in ("full", "identity", "drawing"):
            rows = con.execute(
                "SELECT page FROM sheets WHERE doc_id=? AND vision_need=? "
                "ORDER BY page", (doc_id, need)).fetchall()
            out[f"needs_vision_{need}"] = [r[0] for r in rows]
        # Drawings nobody has read yet. This is the Phase 3 gate's input: a quantity taken
        # off a sheet in this list came from the text layer alone, which cannot see a tag
        # count or a dimension.
        #
        # Filtered by EXCLUDING positively out-of-scope disciplines, never by including an
        # allow list. An allow list drops 'Unknown', and an unparseable sheet number is
        # exactly what produces 'Unknown' - 52 of the 87-sheet reference Bid Set. Those
        # sheets were flagged as needing vision and then quietly omitted from the list the
        # gate reads.
        placeholders = ",".join("?" * len(ix.OUT_OF_SCOPE_DISCIPLINES))
        outstanding = con.execute(
            f"SELECT page, sheet_no, title FROM sheets WHERE doc_id=? AND "
            f"vision_status='required' AND discipline NOT IN ({placeholders}) "
            "ORDER BY page", (doc_id, *ix.OUT_OF_SCOPE_DISCIPLINES)).fetchall()
        out["vision_outstanding"] = [
            {"page": p, "sheet_no": s, "title": t} for p, s, t in outstanding]

        # Sheets the indexer could not name. Reported separately so an odd numbering
        # scheme is visible as a fact about the set rather than silence.
        unnamed = con.execute(
            "SELECT page FROM sheets WHERE doc_id=? AND (sheet_no IS NULL OR sheet_no='') "
            "ORDER BY page", (doc_id,)).fetchall()
        out["unidentified"] = {
            "count": len(unnamed),
            "pages": [u[0] for u in unnamed[:40]],
            "meaning": "No sheet number could be parsed. These are treated as in scope and "
                       "appear in vision_outstanding - cite them by page number.",
        }
        out["next_step"] = (
            f"{len(outstanding)} sheet(s) still need a visual read. "
            "render_sheet each, read the tiles, then record_vision_reading. "
            "Do not take off quantities from these sheets until you have. "
            "find_schedule locates a schedule without knowing its sheet number."
        ) if outstanding else (
            "Every in-scope sheet has been read; search_sheets covers everything.")
        return json.dumps(out, indent=2)
    finally:
        con.close()


def main():
    asyncio.run(mcp.run_stdio_async())


if __name__ == "__main__":
    main()
