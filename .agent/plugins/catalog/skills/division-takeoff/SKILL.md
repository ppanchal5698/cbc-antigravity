---
name: division-takeoff
description: >-
  Use this skill whenever a question spans BOTH a building plan set and the
  vendor price books — "list the Division 10 items in this plan and what
  materials I need", "price the door hardware schedule", "which vendor can
  supply the toilet accessories", "what does the Division 08 scope cost", or any
  request to turn drawings into a material list, takeoff, submittal, or order.
  Drives building-plan-intelligence and catalog-intelligence together across
  every vendor on the shelf: the plan says what is required, the catalogs say
  who can supply it, and the gap between them is reported rather than filled.
---

# Division takeoff

Two kinds of document, two servers, one answer. The plan set states the
**requirement**; the price books state the **supply**, per vendor. This skill
runs them in that order and keeps them separate the whole way.

> The failure mode here is not an incomplete list. It is a complete-looking list
> where one line came from the drawings, the next from a catalog, a third from a
> different vendor's catalog, and a fourth from your own product knowledge —
> indistinguishable to the reader. Every line below carries its source and its
> vendor for that reason.

## 0. Open both sides

```
open_plan_set(pdf_path)      -> doc_id        # plans/
list_catalogs()                               # catalogs/ - what is indexed
```

`list_catalogs` is the catalog-side starting point, not `open_catalog`: several
vendors are on the shelf and the index is cached across sessions. Only
`open_catalog` the books it does not list.

Report both scopes before doing any work:

- the plan set's disciplines and sheet counts, and how many sheets need a vision
  pass (see `plan-set-intake`)
- per vendor: effective date, CSI sections, and **`coverage`**

**Compare the asked-for division against the shelf now.** State up front which
vendors can answer and which part of the division nobody here covers — on this
shelf, toilet partitions (10 21 13), lockers (10 51 00) and fire extinguisher
cabinets (10 44 00) have no vendor. The plan-side enumeration is still worth
doing, but those lines will end in "source elsewhere" and the user deserves to
know before the work, not after.

## 1. Plan side — enumerate the requirement

Work only in `building-plan-intelligence` here. Nothing from a catalog may
enter this step.

### Where each division lives on the drawings

| Division | What to look for | Usual home |
|---|---|---|
| **08 — Openings** | door schedule, window/storefront schedule, hardware groups/sets, frame types, louvers | `A2.2` and schedule sheets; `G1.x` specifications |
| **10 — Specialties** | toilet accessory schedule, signage schedule and sign types, fire extinguisher/cabinet keynotes, lockers, partitions, corner guards, markerboards | interior elevations (`A6.x`), enlarged toilet plans, floor-plan keynotes, `G1.x` specs |

Division 10 is the harder of the two: it is frequently **not** a schedule at
all, but keynotes on an enlarged restroom plan plus a note in the
specifications. Search several vocabularies before concluding an item is absent
— `"TOILET ACCESSOR*"`, `"GRAB BAR"`, `"SIGNAGE"`, `"FIRE EXTINGUISHER"`,
`"PARTITION"`, `"LOCKER"`, `"CORNER GUARD"`, `"MIRROR"`, `"DISPENSER"`,
`"HAND DRYER"`, `"BABY CHANG*"`.

### The procedure

1. `list_sheets` / `search_sheets` to locate the sheets.
2. `read_schedule` on every sheet with tables — **never** flat text. Count the
   rows and report all of them; numbering skips (`01, 02, 03, 06` is four items).
3. `read_layout` for keynotes, legends and unruled accessory lists.
4. `render_sheet` only where the answer is geometric (mounting heights, sign
   locations on an interior elevation).
5. `cross_reference` every manufacturer, series and finish — the spec and the
   schedule disagree often, and the conflict is a finding.
6. Flag anything referenced but never defined (a schedule row calling for
   "GROUP 6" when only Groups 1–4 exist).

### The output of this step

A requirement list, one line per distinct item, each carrying:

- **quantity** — from the drawings, always. No catalog can tell you how many.
- **size / handing / rating / function / mounting** — as stated
- **finish** — as stated, in the drawings' own code
- **specified manufacturer and model** — if the drawings name one
- **sheet citation** and source tag `[schedule]` / `[spec]` / `[note]` /
  `[drawing]` / `[not stated]`

Run `verify_facts(doc_id, [...])` on this list before carrying it forward.
Anything unverified does not cross into step 2.

## 2. Catalog side — find who can supply it

Now, and only now, switch to `catalog-intelligence`. Search the **whole shelf**
in one pass rather than vendor by vendor:

```
list_division("", "10")                   # every Division 10 product, by vendor
match_materials("", [ ...requirements ])  # "" = all indexed catalogs
```

Feed `match_materials` the item as the drawings describe it — including size,
finish and mounting. Longer, more specific requirements match better, not worse.

Read each result carefully:

| Result | Meaning | Do |
|---|---|---|
| `matched: true` | candidates found; `vendors_carrying` names the vendors | `lookup_product` each, pin size + finish |
| `found_in_page_text` | in that catalog, on pages the row parser cannot read | `get_page` there, read models and prices yourself, tag **[catalog-page]** |
| `related_but_wrong_section` | shares wording, different CSI section | **not an answer** — a partition-mounted dispenser is not a partition |
| none of the above | not on the shelf | record as a gap; **do not invent a model** |

Then for every candidate:

```
lookup_product(catalog_id, model)
```

and select the row whose **size, finish and mounting match the drawings**. On
Hager a model has one price per (size, finish) — `1251` runs $53.44 to $90.13.
On the flat accessory books (ASI, Bobrick, Bradley) there is one row per model
and the size lives inside the description — read it there, never assume it.

Before concluding any item is unavailable, check `coverage` on the vendors that
should have carried it. A `text_only` catalog returns nothing however much the
vendor sells: **Rockwood** architectural pulls, **NGP** thresholds, **NUDO** FRP
panels and **World Dryer** dryers all need `search_catalog` + `get_page`.

## 3. Reconcile — five buckets, not one list

Sort every requirement line into exactly one:

1. **Supplied** — a vendor carries it, size/finish/mounting confirmed against
   the drawings. Give vendor, model, size, finish, price + basis, item number,
   catalog page.
2. **Supplied, multiple vendors** — list the options with prices and let the
   reader choose. Do not silently pick the cheapest.
3. **Substitution** — a vendor carries an equivalent, but the drawings specify a
   different manufacturer. Say so explicitly: specified product, proposed
   substitute, vendor, and that substitution normally requires approval.
4. **Not carried** — no vendor on this shelf. Name the item and division. This
   is a real deliverable, not a failure. Add **[not indexed]** if it might be in
   one of the spreadsheets the server cannot read.
5. **Unresolved** — the drawings do not state enough to pick a product (no
   finish, no size, an undefined hardware group). Say what is missing and who
   has to answer it.

## 4. Verify each document separately, then answer

A fact verified in one document is not verified in another. One call per source:

```
verify_facts(doc_id,     [ plan claims: quantities, sizes, finishes, tags ])
verify_facts(catalog_id, [ that vendor's models, item numbers, prices ])
```

One `verify_facts` per vendor whose products you are quoting. Delete anything
`verified: false`. Never reinstate it from product knowledge.

## 5. Present it

A table per bucket, most useful first. One row per item:

| Item | Qty | Required (plan) | Vendor | Supplied (catalog) | Price each | Basis | Source |
|---|---|---|---|---|---|---|---|
| Baby changing station, horizontal, surface mtd | 2 | recessed, SS housing | ASI | `10-9012` | $515.60 | list | `A6.1` [schedule] · ASI p8 [catalog] |

Rules for the table:

- **quantities from the plan, prices from the catalog** — never the other way
- every price carries its **basis**: `list`, or `net` for Bobrick. If you applied
  a multiplier, show the arithmetic and name where the multiplier came from —
  and say if it came from a file name rather than a multiplier sheet
- every row names the **vendor** and cites **both** documents with source tags
- not-carried and unresolved items appear in the answer, not in a footnote

Close with what you could not confirm: `partial` / `text_only` catalogs not read
page by page, spreadsheets the server cannot open, drawings that do not state a
finish, hardware groups with no definition.

**A short takeoff that is entirely correct beats a comprehensive one that is 85%
correct.** On construction documents the 15% is what costs money.
