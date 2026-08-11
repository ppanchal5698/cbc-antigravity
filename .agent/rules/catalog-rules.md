---
name: catalog-rules
description: Mandatory accuracy procedure for pricing and specifying products from the vendor price books in catalogs/ with the catalog-intelligence MCP server, including multi-vendor routing and how catalog answers combine with building-plan answers.
trigger: always_on
---

# Reading vendor catalogs

Applies whenever you work with a price book through `catalog-intelligence`, and
whenever a catalog answer is combined with a plan-set answer from
`building-plan-intelligence`.

A price book is an ordering document. A wrong model number becomes a wrong
delivery; a wrong finish code becomes the right product in the wrong colour on a
job that has already started; a list price quoted as a cost becomes a bid that
loses money. **Accuracy beats completeness every time.** "No vendor on this
shelf carries it" is a complete, correct, professional answer.

## There is a shelf, not a catalog

`catalogs/` holds several vendors' price books, one folder per vendor. Two
consequences that change how every tool is called:

1. **`list_catalogs` first**, whenever more than one vendor could answer. It
   reports what is indexed, each vendor's CSI sections, and — critically — each
   catalog's `coverage`.
2. **Pass `catalog_id=""`** to `list_division` and `match_materials` to search
   the whole shelf in one call. Each result names the vendor carrying it. Do not
   loop catalog by catalog, and do not answer "not carried" from a single book.

A product missing from one vendor is not missing from the shelf. A product
missing from the shelf is a real gap — say so, and do not fill it.

## coverage: what a catalog can and cannot answer

`open_catalog` and `list_catalogs` report one of three values. Route on it:

- **`structured`** — product rows parsed across the book. `list_division` and
  `match_materials` are authoritative for it.
- **`partial`** — some pages parsed, the rest not. Treat its product rows as
  real but its *absences* as unknown.
- **`text_only`** — **no product rows at all.** It is invisible to
  `list_division` and `match_materials` no matter how much the vendor sells.
  Use `search_catalog` and `get_page`, and read prices off `text_rows` yourself.

**Never read a `partial` or `text_only` catalog's silence as "this vendor does
not carry it."** On this shelf that would wrongly write off Rockwood's
architectural pulls (finish-matrix pricing), National Guard's thresholds
(priced per foot by formula), NUDO's FRP panels and World Dryer's dryers.

`catalog-intelligence` indexes **PDF and `.xlsx` / `.xlsm`**. A spreadsheet price
list is parsed into the same product rows a PDF yields — World Dryer's real book
and Hamilton Parker's own net-cost sheets are indexed, not invisible.

Spreadsheets are where the shelf's *net* pricing lives, so read `price_basis` on
every row from one. A distributor sheet prints LIST, DEALER, COMMERCIAL, MAP and
NET side by side, and each becomes its own row carrying its own basis; a row
whose `already_net` is true is a cost, and applying a vendor multiplier to it
under-prices the job.

Still not readable: **`.xls`** (the old binary format), **`.docx`** and
**`.msg`** — `BOBRICK/Gamco Cross over (2).xls`, `BOBRICK/Multiplier.docx` and
`NUDO/FW Pricing Sheets…msg`. If the answer needs one of those, say it must be
opened by hand.

## The two documents never mix

A plan set and a catalog are separate sources and are verified separately:

- **The plan says what is required.** Quantities, locations, handing, ratings,
  sizes, and the specified manufacturer come from the drawings — never from a
  catalog. A catalog cannot tell you how many doors a building has.
- **The catalog says what can be supplied.** Model numbers, finish codes, pack
  quantities, item numbers, and prices come from the price book — never from the
  drawings, and never from your own product knowledge.

Run `verify_facts` **on both servers**: plan facts against the `doc_id`, catalog
facts against the `catalog_id` of the specific book you took them from. A model
verified in one vendor's book is not thereby in another's, nor in the drawings.

## The six rules

### 1. Check coverage before you answer

`open_catalog` returns `divisions` — the CSI divisions that book contains. That
is its entire scope. `list_catalogs` gives the same across the shelf.

If nothing on the shelf covers the division, say so plainly and stop. Do not
substitute from a covered division and do not fill from product knowledge.
Expect partial coverage *within* a division: Hager's Division 10 content is 27
products (ADA signage, coat hooks, one corner guard) and no toilet partitions,
lockers or extinguisher cabinets — those come from ASI, Bobrick or Bradley, or
from nobody here.

### 2. A price belongs to a model *and a size and a finish*

There is no such thing as "the price of Hager 1251". There is $53.44 for USP at
3-1/2" x 3-1/2" and $90.13 for US3 at 4" x 4" — a 70% spread on one model.

Always quote the `(model, size, finish)` row. If the drawings do not pin a
finish or size, report the range and say the drawings do not pin it. Never pick
one silently.

### 3. Say what basis the price is on

Most books on this shelf list **list** prices. Bobrick's columns are headed
*Net Cost Each*. Say which you are quoting, every time.

Five filenames carry a multiplier and `open_catalog` reports it as
`multiplier_in_filename` (ASI `.375`, NGP `.45`, Rockwood Accessories `.55`,
World Dryer `.339`; Bradley's `.53` is in its filename but not auto-detected).

That number came from a **file name, not a document.** It is a routing hint, not
an authority. Before applying it, confirm it against the vendor's own multiplier
sheet — `HAGER/Hager Multipliers and Special Nets`, `BOBRICK/Multiplier.docx`.
If you do apply one, show the arithmetic and name the source. Never present a
list price as a cost, and never produce a bid number without saying which basis
and which multiplier produced it.

### 4. A gap is not a blind spot — and neither is a guess

When `match_materials` returns `matched: false`, read *which* of three it is:

- **`found_in_page_text` present** — the product IS in that catalog, on pages
  whose layout the row parser does not read. Call `get_page` there and read the
  models and prices yourself. Do not report it as unavailable.
- **`related_but_wrong_section` present** — products share wording but sit in a
  different CSI section. A partition-mounted dispenser is not a partition.
  These are not answers; report the requirement as not carried unless you have
  checked one and it genuinely satisfies the requirement.
- **Neither** — genuinely not in the searched catalogs. If you searched one
  book, retry with `catalog_id=""` before telling the user no vendor has it.

Also check `sections_without_price_rows` and `coverage` before calling any
enumeration complete, and `truncated` on `list_division` before calling a list
exhaustive.

### 5. Verify every model number and price before you answer

Collect every catalog claim — model, item number, finish code, size, price — and
run `verify_facts(catalog_id, [...])` against the book it came from, in one call
per book, before writing the response.

Anything returning `verified: false` **is not in that catalog.** Delete it or
replace it with the catalog's exact wording. `near_miss` shows where the real
wording is. Never restore it from product knowledge.

This is the last step before answering. Not optional.

### 6. One requirement, one vendor decision

When several vendors carry an equivalent product, present the options with their
prices and let the reader choose. Do not silently pick the cheapest, and do not
merge two vendors' products into one line. If the drawings name a manufacturer,
that vendor's product is the answer and the others are alternates.

## A catalog match is a proposal, not a specification

`match_materials` returns text matches ranked by wording. A candidate becomes an
answer only after you have confirmed, against the drawings, that it satisfies:

- **size and handing** — a 4" x 4" hinge does not answer a 4-1/2" x 4" opening;
  a 36" grab bar does not answer a 42" one
- **finish** — the schedule's finish code must exist in the catalog's rows for
  that model
- **mounting** — surface, recessed, semi-recessed and partition-mounted are
  different products at different prices
- **rating** — fire, ADA and life-safety ratings are stated in the catalog text,
  not in the price row; check the page with `get_page`
- **function** — passage, privacy, classroom, storeroom are different products

Say which of these you confirmed and which you could not.

## When the plan names a different manufacturer

If the drawings specify a manufacturer and you are proposing another vendor from
this shelf, that is a **substitution** and must be labelled one — never
presented as what the drawings call for. Report the specified product, the
proposed substitute, the vendor, and the fact that substitution normally
requires approval. Do not claim equivalence you have not checked attribute by
attribute.

## Label every fact with where it came from

- **[schedule]** / **[spec]** / **[note]** / **[drawing]** — from the plan set,
  with sheet number and title (see the building-plan rules)
- **[catalog]** — a parsed price row: vendor, model, PDF page
- **[catalog-page]** — read by you off `get_page` text rows because that
  section or catalog is not parsed; less certain than a price row, say so
- **[not carried]** — no vendor on this shelf sells it
- **[not indexed]** — it may exist in an `.xls`, `.docx` or `.msg` on the shelf that
  the server cannot read
- **[not stated]** — the plan set does not say

Never present these as equally certain, and never let outside product knowledge
enter unlabelled — ideally, not at all.
