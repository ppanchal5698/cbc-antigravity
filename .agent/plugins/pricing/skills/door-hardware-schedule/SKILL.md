---
name: door-hardware-schedule
description: Division 08 takeoff - read the door schedule, derive frame throats, expand the spec's hardware sets, translate finishes, and price each opening.
---

# Door & hardware schedule takeoff (Division 08)

## 1. Read the schedule as rows

Locate it: `search_sheets(doc_id, '"DOOR SCHEDULE"')`, typically `A2.2` or a schedule sheet.
Then `read_schedule(doc_id, sheet)` — **never** flat sheet text. Sheet text interleaves
columns from unrelated tables, which pairs a value with the wrong row and drops rows
entirely.

Capture per opening: tag · size code · door material and type (HM, SCWD, laminate) · frame
material and type (welded, knock-down) · wall type · handing (LH/RH/LHR/RHR) · fire rating ·
hardware group callout.

**Enumerate every row.** Numbering skips — `01, 02, 03, 06` is four doors, and `06` is
exactly the row a careless reader drops. Report the tags as they appear; never infer that
`04` and `05` exist.

## 2. Sizes and throats

`parse_door_size("3070")` → 3'-0" x 7'-0". Drives kick plate width (door width minus 2") and
threshold and sweep length (equal to the opening width).

`calculate_frame_throat(wall_type)` for the depth, or
`okf_query("frame_throat", "<wall description>")` for a learned mapping with its confidence.
Five standards cover most work: `5-5/8"` (1/2" drywall) · `5-7/8"` (5/8" Type X, the
commercial default) · `5-3/4"` (CMU) · `7-3/4"` (wood stud) · `8-1/4"` (6" stud). Anything
else is a custom depth and a manual entry; adjustable frames also exist.

## 3. Hardware sets — the spec is the authority

**Read the spec's own hardware schedule first.** Architects specify by part number and
series — Hager 3400 vs 3500 is grade 1 vs grade 2 — and requirements 7.7 is explicit that
the spec states what is required while CBC's library states what is quoted. Quote the spec's
part numbers, reconciled to CBC's stock lines.

There is **no single standard hardware list** (requirements 7.2). Where the spec defines no
set for a callout:

```
expand_hardware_set(set_callout, door_size, handing, fire_rating, finish, keyway, core_type)
```

returns CBC's *reference* grouping, tagged `requires_estimator_confirmation: true`. Present
it as a completeness checklist, never as what the drawings call for.

A callout with no definition anywhere in the set — "GROUP 6" when only 1 to 4 are
scheduled — is a genuine finding and an RFI, not something to fill in.

Beyond the stock top-N there is a deliberate manual cut-off (NR-13). Do not try to price
every option permutation; hand the long tail to the estimator.

## 4. Fire-rated openings

If an opening carries a rating, the door, the frame **and** every piece of hardware must be
UL-listed for it — an unrated match on a rated opening is a defect. Check the catalog page
with `get_page`; ratings live in the catalog text, not in the price row.

CBC has **not** confirmed where ratings live in their bid sets or which categories price on
them (7.3 / Open Item 9). Record what the documents say, flag anything missing, and raise
the convention itself as an RFI rather than assuming one.

## 5. Finishes, lites and louvers

`convert_finish_code(code)` translates both directions — `US26D` = `626`, `US32D` = `630`,
`US19` = `622`, `US15` = `619`. Both systems appear in real specs. Premium finishes come
back flagged for lead time and a possible adder.

For vision lites and louvers, `calculate_lite_louver_price` returns the lookup route; the
prices themselves come from the NGP, Pemko/Markar or Rockwood books — all `text_only` or
`partial`, so `search_catalog` + `get_page`.

## 6. Adders

Electrification, non-removable-pin hinges and premium finishes carry adders the base price
book does not show cleanly. **CBC has not supplied the values** (NR-7). Look them up in the
Hager book with `search_catalog` + `get_page`, or prompt the estimator. Never quote one from
memory.

## 7. Price and verify

Multipliers: Hager `0.29` · Rockwood `0.55` · NGP and Pemko `0.45`. Allegion lines
(Von Duprin, LCN, Schlage, Ives) are not direct — they route to Banner Solutions or SecLock
for a manual net.

`get_margin_band("commodity", customer)` then `calculate_quote_line(...)` with the source and
its citation. Confidence: `HIGH` exact model and finish · `MEDIUM` substitution proposed ·
`LOW` schedule ambiguous.

Then one call per source:

```
verify_facts(doc_id,     [ tags, sizes, ratings, handing ])
verify_facts(catalog_id, [ models, finishes, prices ])
```

Output door by door with an opening subtotal, each fact tagged `[schedule]` `[spec]`
`[note]` `[drawing]` `[not stated]`, and every price citing vendor, page, basis and
multiplier.
