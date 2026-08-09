# building-plan-intelligence

An MCP server that lets **any IDE, using its own LLM/VLM**, read and reason about
large architectural/engineering plan sets.

The server owns no model. It is a text-and-pixel provider with a cache: it
extracts what a PDF text layer can give, renders readable image tiles for
everything else, and lets the calling model write back what it read so each
sheet is only ever read once.

## Why it works this way

Measured on two real plan sets (a 65-sheet Dutch Bros set and an 87-sheet
Dairy Queen bid set), both 36×24in:

| | Dutch Bros | Bid Set |
|---|---|---|
| Pages | 65 | 87 |
| Sheets auto-identified | **65/65** | 33/87 |
| No text layer at all | 0 | 24 |
| Body text, but outlined title block | 0 | 30 |

Three findings drive the design:

1. **A whole 36×24 sheet is unreadable to a vision model.** Body annotation text
   is 9–9.5pt. Downsampled to a VLM's ~1568px budget it lands at **~5px** tall.
   Split into a 3×2 grid the same text lands at **~16px** and reads cleanly
   (verified visually). `render_sheet` therefore tiles by default, with 6%
   overlap so callouts at tile edges aren't cut mid-word.
2. **Plenty of sheets have no text to extract.** Their text was converted to
   vector outlines — 20k–46k paths and zero characters. No parser will ever read
   them; only a vision model can. Hence `vision_need`:
   - `none` — text layer intact, `search_sheets` covers it
   - `identity` — drawing is searchable but its title block was outlined, so the
     sheet number is unknown
   - `full` — no text at all
3. **Title blocks vary by firm.** One set labels them (`SHEET NUMBER:`), the
   other doesn't. Identification is geometric first (largest sheet-number-shaped
   token in the title-block strip), then PDF bookmarks, then the cover-sheet
   drawing index — recorded per sheet in a `source` field so you know how much
   to trust it.

## Install

```bash
pip install -e .
```

## Configure your IDE

### Antigravity (IDE **and** CLI) — configured

Both read one global file: `~/.gemini/config/mcp_config.json`. Antigravity's
schema supports only `command` / `args` / `env` — there is no `cwd` key — so the
package is put on the path via `PYTHONPATH`:

```json
{
  "mcpServers": {
    "building-plan-intelligence": {
      "command": "<workspace>\\.venv\\Scripts\\python.exe",
      "args": ["-m", "bpi.server"],
      "env": {
        "PYTHONPATH": "<workspace>\\.agent\\mcp\\building-plan-intelligence",
        "BPI_CACHE": "<workspace>\\.agent\\cache\\building-plan-intelligence",
        "PYMUPDF_MESSAGE": "fd:2"
      }
    }
  }
}
```

Restart the IDE (or start a new `agy` session) to pick it up. In the IDE the
server and its tools appear under **Additional Options (…) → MCP Servers**.

### Cursor / VS Code / Claude Code / Windsurf

These support `cwd`, so either form works:

```json
{
  "mcpServers": {
    "building-plan-intelligence": {
      "command": "python",
      "args": ["-m", "bpi.server"],
      "cwd": "<workspace>/.agent/mcp/building-plan-intelligence"
    }
  }
}
```

The index is cached at `~/.cache/building-plan-intelligence/index.db`; override
with the `BPI_CACHE` environment variable. Both Antigravity IDE and CLI share
that one cache, so a set indexed in either is instantly available in the other.

## Tools

| Tool | Purpose |
|---|---|
| `open_plan_set(pdf_path)` | Index the set (cached by mtime/size), return `doc_id` + summary |
| `plan_overview(doc_id)` | Disciplines, sheet ranges, what still needs a vision pass |
| `list_sheets(doc_id, discipline, vision_need)` | The sheet index, filterable |
| `get_sheet(doc_id, sheet)` | Title block, reading-order text, table count (accepts `A2.0` or `13`) |
| **`read_schedule(doc_id, sheet, region)`** | **Schedules as real rows — use for every table** |
| `read_layout(doc_id, sheet, region)` | Text as spatial rows with column breaks marked |
| `search_sheets(doc_id, query)` | FTS5 search across PDF text *and* vision-recorded text |
| **`cross_reference(doc_id, term)`** | **Every mention across the set — surfaces spec/schedule conflicts** |
| **`verify_facts(doc_id, claims)`** | **Check claims are actually in the document before reporting** |
| `render_sheet(doc_id, sheet, tile, dpi, cols, rows, region)` | Readable PNG tiles |
| `record_vision_reading(doc_id, sheet, text, tile)` | Write back what the VLM read |

Intended loop for the calling model:

```
open_plan_set → plan_overview → search/list
   ↓
read_schedule (tables)  ·  read_layout (notes)  ·  get_sheet (overview)
   ↓ for sheets with vision_need "full" or "identity"
render_sheet → (your VLM reads the tiles) → record_vision_reading
   ↓
cross_reference every product  →  verify_facts every claim  →  answer
```

### Why the last three tools exist

A vision-capable IDE read this Dutch Bros set and produced a Division 08/10
takeoff that was ~85% right. Every remaining error traced to one of three
causes, and each tool closes one:

- **Schedules read as flat text.** `get_text()` on a plan sheet interleaves
  columns from unrelated tables, which pairs values with the wrong row and hides
  rows completely. It dropped door `06` (numbering runs 01, 02, 03, 06) and
  misread a panic device as 36" when the sheet says 26". `read_schedule` returns
  the ruled grid as rows. `get_sheet` now also warns when a sheet has tables.
- **Conflicts silently resolved.** The spec says `Kawneer Trifab VG 451T`; a
  note on A2.2 says `KAWNEER 541T`. Only one got reported. `cross_reference`
  shows every mention across the set side by side.
- **Gaps filled from product knowledge.** `Alarm Lock` in the schedule became
  "Alarm Lock Trilogy"; a stainless spec reading `Finish: 2D, dull` was reported
  as "#4 satin". `verify_facts` checks each claim against the indexed text and
  returns `verified: false` for anything absent, with `near_miss` pointing at the
  real wording.

The index stores text in **reading order**, not raw extraction order — otherwise
terms that sit side by side on the sheet land far apart in the string and
verification misses them.

If a tile is still too small to read, raise `cols`/`rows` rather than `dpi` —
more tiles means more pixels per inch of drawing after downsampling, whereas
raising DPI on a whole tile is undone by the model's resize.

`region="x0,y0,x1,y1"` (inches from the sheet's top-left) zooms a specific
detail — useful once a callout has been located and needs a closer look.

## Generalizing to other plan sets

Nothing is hard-coded to these two documents. Sheet numbers are matched by
pattern, disciplines by prefix with unknown prefixes passing through rather than
erroring, and the title block is located by page geometry. Sheet sizes other
than 36×24 work — adjust `cols`/`rows` to suit.

## Test

```bash
python test_bpi.py
```

Indexes both reference sets and asserts the numbers in the table above, plus a
render and a vision write-back round-trip. It also asserts total indexing time,
which is the regression guard described below.

## One trap worth knowing

Never use `page.get_text("dict")` in this codebase. On Bid Set page 60 it takes
**187–223 seconds** — and still 187s when clipped to a small rect. The same page
in `"words"` mode takes **0.6s**. All extraction uses `words` mode and treats
word bbox height as the font-size proxy. The timing assertion in `test_bpi.py`
exists to catch anyone reintroducing `dict`.

## Licensing

PyMuPDF is **AGPL-3.0** (or a paid Artifex commercial license). That is fine for
internal use, but redistributing this server or offering it to third parties
over a network triggers AGPL obligations. `pypdfium2` (Apache-2.0/BSD-3) is the
usual swap if that becomes a problem; it would need a replacement for the
word-position extraction this server relies on.
