"""building-plan-intelligence MCP server.

Serves text and pixels from architectural plan sets. It owns no model: the
calling IDE's own LLM/VLM does the reading. Sheets whose text was converted to
vector outlines can only be read by vision, so this server renders them as
readable tiles and lets the caller write back what it read.
"""

import asyncio
import base64
import json

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
        "for sheets whose vision_need is 'full' or 'identity'. "
        "6) verify_facts on every claim before you answer.\n"
        "FOUR RULES THAT PREVENT WRONG ANSWERS:\n"
        "1. Schedules: always read_schedule, never flat text. Sheet text interleaves "
        "columns from unrelated tables, which silently pairs values with the wrong "
        "row and hides whole rows.\n"
        "2. Enumerate: count the rows a schedule returns and report every one. "
        "Numbering skips (01,02,03,06) - never assume a range is contiguous.\n"
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
                "full": need.get("full", 0),
            },
            "hint": ("Sheets with vision_need 'full' have no text layer at all; "
                     "'identity' means the drawing is searchable but its title "
                     "block was outlined so the sheet number is unknown. Use "
                     "render_sheet + record_vision_reading on those."),
        }, indent=2)
    finally:
        con.close()


@mcp.tool()
def list_sheets(doc_id: str, discipline: str = "", vision_need: str = "") -> str:
    """List the sheet index: sheet number, title, page, discipline.

    Filter by discipline (e.g. 'Architectural') or by vision_need
    ('none' | 'identity' | 'full') to find sheets still unread.
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
            return json.dumps({"error": f"no sheet or page matching {sheet!r}"})
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
            return json.dumps({"error": f"no sheet or page matching {sheet!r}"})
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
            return json.dumps({"error": f"no sheet or page matching {sheet!r}"})
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
        pages = con.execute(
            "SELECT page, source, body FROM sheet_text WHERE doc_id=?", (doc_id,)).fetchall()
        meta = {p: (s, t) for p, s, t in con.execute(
            "SELECT page, sheet_no, title FROM sheets WHERE doc_id=?", (doc_id,))}
        blobs = [(p, src, ix.norm(b)) for p, src, b in pages]

        results = []
        for claim in claims:
            q = ix.norm(claim)
            if not q:
                continue
            hits = [{"page": p, "sheet": meta.get(p, (None, None))[0], "found_in": src}
                    for p, src, b in blobs if q in b]
            entry = {"claim": claim, "verified": bool(hits), "found_on": hits[:6]}
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
        return json.dumps({
            "checked": len(results),
            "verified": len(results) - len(bad),
            "unverified": bad,
            "results": results,
        }, indent=2)
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
                 cols: int = DEFAULT_COLS, rows: int = DEFAULT_ROWS,
                 region: str = "") -> list:
    """Render a sheet as image tiles for your vision model to read.

    A 36x24in sheet rendered whole is unreadable (9pt notes land at ~5px after
    downsampling). Split into a 3x2 grid the same text lands at ~16px.

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
            return [{"type": "text", "text": f"no sheet or page matching {sheet!r}"}]
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
                grid = _tiles(page.rect, max(1, cols), max(1, rows))
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
            return json.dumps({"error": f"no sheet or page matching {sheet!r}"})
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
        con.execute("UPDATE sheets SET vision_need='none' WHERE doc_id=? AND page=?",
                    (doc_id, page))
        con.commit()
        return json.dumps({"page": page, "recorded_chars": len(text),
                           "sheet_no_set": found, "vision_need": "none"})
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
        for need in ("full", "identity"):
            rows = con.execute(
                "SELECT page FROM sheets WHERE doc_id=? AND vision_need=? "
                "ORDER BY page", (doc_id, need)).fetchall()
            out[f"needs_vision_{need}"] = [r[0] for r in rows]
        out["next_step"] = (
            "Call render_sheet on the pages listed in needs_vision_full / "
            "needs_vision_identity, read the tiles, then record_vision_reading."
        ) if (out["needs_vision_full"] or out["needs_vision_identity"]) else (
            "Whole set has a text layer; search_sheets covers everything.")
        return json.dumps(out, indent=2)
    finally:
        con.close()


def main():
    asyncio.run(mcp.run_stdio_async())


if __name__ == "__main__":
    main()
