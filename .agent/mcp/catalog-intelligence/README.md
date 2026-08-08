# catalog-intelligence

An MCP server that turns a **vendor price book / product catalog PDF** into a
queryable, CSI-tagged product index.

It is the supply side of the pair with
[`building-plan-intelligence`](../building-plan-intelligence): that server says
what the drawings require, this one says what the vendor actually sells against
it — with real model numbers, sizes, finishes, list prices and order item
numbers, or an explicit "this vendor does not carry it".

The server owns no model. Its job is to make sure the calling LLM never has to
guess a model number or a price.

## Reference shelf

Measured on 10 vendors' price books (17 PDFs, ~1,300 pp, all with text layers —
no vision pass needed anywhere):

| Vendor | pp | Coverage | Price rows | Models |
|---|---|---|---|---|
| Hager (door hardware) | 744 | structured | 9,122 | 963 |
| ASI (washroom accessories) | 62 | structured | 1,427 | 989 |
| Bradley | 44 | structured | 705 | 703 |
| Pemko / Markar | 84 | structured | 711 | 470 |
| Bobrick · Gamco | 29 · 12 | structured | 766 | 746 |
| Rockwood Glass Solutions | 44 | structured | 139 | 125 |
| Rockwood Architectural / Accessories, NGP ×2, NUDO ×2, World Dryer | — | partial / text_only | — | — |

`coverage` is the field callers route on: **structured** (product rows across
the book), **partial** (some pages parsed), **text_only** (none — the book is
searchable but invisible to `list_division`). The last group is priced by finish
matrix, by the foot as a formula, or carries no prices at all.

The CSI table for the Hager book is the reason products are classified
individually rather than by section:

| Division | CSI section | Models |
|---|---|---|
| 08 — Openings | 08 71 00 Door Hardware | 833 |
| 08 — Openings | 08 71 13 Automatic Door Operators | 46 |
| 10 — Specialties | 10 14 00 Signage · 10 28 00 Accessories · 10 26 00 Wall Protection | 27 |

A door-hardware book is *mostly* Division 08, but it still carries 27 Division
10 products (ADA signage, coat hooks, a corner guard) buried in a section called
"Trim & Auxiliary". Section-level tagging would answer a Division 10 question
with "nothing here".

## Why it works this way

Findings from the reference shelf that drive the design:

1. **`find_tables()` cannot read a price book.** On a Hager price page it
   returns exactly one row — the header. The 9,000+ price lines beneath it are
   not ruled, so they are invisible to the table finder. Price rows are instead
   recovered by assigning every word to a column using the header labels' x
   positions.
2. **Description and size are vertically *centered* against the rows they
   own.** They sit above some of their price rows and below others, so neither
   carry-forward nor "which group contains this y" gets them right. Sizes are
   grouped into blocks and each price row takes the nearest block by center;
   descriptions start wherever a model-shaped token appears in the description
   column.
3. **Most vendors are not laid out like Hager at all.** ASI, Bobrick and Bradley
   print one product per line — `MODEL | description | cube | weight | price` —
   with no column-header band to lock onto. `parse_line_items` is the fallback:
   the first cell is the catalogue number, the last price-shaped token is the
   price, and the most alphabetic cell between them is the description. Without
   it, 15 of the 17 reference books index to zero products.
4. **A model does not have a price.** `1251` costs \$53.44 in USP at 3½×3½ and
   \$90.13 in US3 at 4×4 — a 70% spread on one model. Tools return the
   (model, size, finish) triple, never a bare model price.
5. **A longer requirement must not match less than a short one.** Scoring only
   the rare words made *"36 inch stainless grab bar"* find nothing while *"grab
   bar"* found grab bars, because "bar" had been discarded as generic. Matching
   now ranks on every word but gates on the distinguishing ones, and confines
   candidates to the requirement's own CSI section — a partition-mounted
   dispenser is not a toilet partition.

Pages and whole catalogs the row parsers cannot read still have their text
indexed. `open_catalog` reports them via `coverage` and
`sections_without_price_rows`, and `match_materials` returns
`found_in_page_text` rather than a false gap, so the caller reads those pages
with `get_page` instead of assuming the shelf is complete.

## Install

```bash
pip install -e .
```

## Configure your IDE

### Antigravity (IDE **and** CLI)

Both read one global file: `~/.gemini/config/mcp_config.json`. Its schema
supports only `command` / `args` / `env` — no `cwd` — so the package goes on the
path via `PYTHONPATH`:

```json
{
  "mcpServers": {
    "catalog-intelligence": {
      "command": "C:\\Python314\\python.exe",
      "args": ["-m", "catint.server"],
      "env": {
        "PYTHONPATH": "C:\\Parth Panchal\\mcp-servers\\catalog-intelligence"
      }
    }
  }
}
```

### Cursor / VS Code / Claude Code / Windsurf

These support `cwd`:

```json
{
  "mcpServers": {
    "catalog-intelligence": {
      "command": "python",
      "args": ["-m", "catint.server"],
      "cwd": "C:/Parth Panchal/mcp-servers/catalog-intelligence"
    }
  }
}
```

The index is cached at `~/.cache/catalog-intelligence/catalog.db`; override with
the `CATINT_CACHE` environment variable. Catalogs are keyed by path + mtime +
size, so re-opening an unchanged file is instant and several catalogs coexist in
the one database.

## Tools

| Tool | Purpose |
|---|---|
| `open_catalog(pdf_path)` | Index one book (cached), return `catalog_id`, `coverage` + **which CSI divisions it actually covers** |
| **`list_catalogs()`** | **The whole shelf: vendor, effective date, coverage, CSI sections** |
| **`list_division(catalog_id, division)`** | **Every product in a CSI division — "list all the Division 10 items"** |
| `list_sections(catalog_id)` | One catalog's own sections, page ranges, CSI tags |
| **`match_materials(catalog_id, requirements)`** | **Map plan requirements onto real products, or report a gap** |
| `lookup_product(catalog_id, model)` | Every size × finish price row for a model, plus order item numbers |
| `search_catalog(catalog_id, query, section)` | FTS5 search across every page |
| `get_page(catalog_id, page)` | One page as spatial rows with column breaks — footnotes, adders, ratings |
| **`verify_facts(catalog_id, claims)`** | **Check every model number and price against the book before reporting** |

`list_division` and `match_materials` accept **`catalog_id=""`** to search every
indexed catalog at once; each result names the vendor carrying it. With one book
per vendor that is the normal call — "who supplies this" rather than "does this
one".

Intended loop for the calling model:

```
building-plan-intelligence: read_schedule → the Division 10 items the plan calls for
   ↓
list_catalogs → who is on the shelf, and each book's `coverage`
   ↓
list_division("", …) enumerate  ·  match_materials("", …) map requirements → vendors
   ↓
lookup_product for each candidate — pin the size and finish the spec calls for
   ↓
verify_facts every model number and price, per vendor  →  answer
```

### Why the honesty tools exist

The failure mode of a catalog assistant is not missing an answer, it is
producing a confident wrong one. Four guards:

- **Coverage is stated up front.** `open_catalog` returns the divisions the book
  actually contains. Ask `list_division(cid, "22")` of a door-hardware book and
  you get an empty list, the covered divisions, and an instruction not to
  substitute.
- **Silence is qualified.** `coverage: "text_only"` says a catalog produced no
  product rows at all, so `list_division` finding nothing there means nothing.
  Four of the seventeen reference books are in that state.
- **Matching gates on the words that distinguish.** A plain keyword OR matches
  *"stainless steel toilet partition"* against every stainless steel hinge on the
  shelf. `match_materials` measures how common each word is, requires a candidate
  to hit at least one word describing under 10% of the corpus, ranks on all the
  words, and confines candidates to the requirement's own CSI section. *"corner
  guards"* returns exactly `185G`; *"metal lockers"* returns a gap; *"toilet
  partitions"* does **not** return ASI's partition-mounted dispensers.
- **A gap is distinguished from a blind spot.** When nothing matches,
  `match_materials` re-checks the full page text. *"pile weatherstripping"*
  comes back unmatched **with** `found_in_page_text` pointing at the Hager
  threshold pages — real product, unparsed layout — while *"metal lockers"*
  comes back as a true gap to source from another vendor.

### Price basis

Most books here quote **list**; some quote net (Bobrick's columns are headed
*Net Cost Each*). Net cost otherwise needs the vendor's multiplier sheet, a
separate document (for Hager, *"Hager Multipliers and Special Nets"*).

Distributors often file the multiplier in the **file name**
(`ASI-Price-List - 1-12-26 - .375 Multiplier.pdf`). `open_catalog` extracts it
as `multiplier_in_filename` — a routing hint, never an authority. It is never
applied to a price. Confirm it against the vendor's own sheet, and say so
whenever a net number is quoted.

## Generalizing to other catalogs

Nothing is hard-coded to one vendor. Two parsers run in order — the
column-header layout, then the flat line-item layout — and between them they
read 8 of the 10 reference vendors. Sections come from the running head, the
vendor from the containing folder, models by pattern, and the CSI rules in
`catint/index.py` are an ordered keyword table: add a rule to cover a division a
new vendor carries.

Layouts neither parser reads (finish matrices with prices as bare integers,
per-foot formula pricing) still index and search; they report `coverage:
"text_only"` rather than pretending to be empty. Adding a third parser is the
right move only once a specific catalog's pricing matters enough — and the
"read it with `get_page`" path is honest in the meantime.

**PDF only.** Spreadsheets and .msg files are not indexed.

## Test

```bash
python test_catint.py
```

Indexes the Hager book and ASI's, and asserts: the parsing traps (centered
sizes, three-label headers in the Locks section, flat line items with no header
band), the CSI classification, cross-catalog vendor routing, that a longer
requirement does not match less than a short one — and, in most of the
assertions, that gaps are reported as gaps.

## Licensing

PyMuPDF is **AGPL-3.0** (or a paid Artifex commercial license). Fine for
internal use; redistributing this server or offering it to third parties over a
network triggers AGPL obligations.
