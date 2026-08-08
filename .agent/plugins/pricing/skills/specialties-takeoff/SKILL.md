---
name: specialties-takeoff
description: Division 10 takeoff - washroom accessories and commercial hand dryers matched across ASI, Bobrick/Gamco, Bradley and World Dryer, plus the partition and locker gaps this shelf cannot fill.
---

# Specialties takeoff (Division 10)

## 1. Find the requirement — it is often not a schedule

Division 10 is the harder of the two divisions: frequently there is no accessory schedule at
all, just keynotes on an enlarged restroom plan plus a paragraph in the specification.

Search several vocabularies before concluding an item is absent:
`"TOILET ACCESSOR*"` · `"GRAB BAR"` · `"DISPENSER"` · `"HAND DRYER"` · `"MIRROR"` ·
`"BABY CHANG*"` · `"SEAT COVER"` · `"NAPKIN"` · `"PARTITION"` · `"LOCKER"` ·
`"FIRE EXTINGUISHER"`.

- `read_schedule` if there is a table.
- `read_layout` on enlarged restroom plans and keynote legends.
- `render_sheet` on interior elevations when the **count** is only visible — an accessory
  drawn twice on an elevation is two of them. Tag anything read this way `[drawing]`.

Capture per item: tag (`TA-1`, `GB-1`, `PTD`, `HD`), description, mounting (surface,
recessed, semi-recessed, partition-mounted — these are different products at different
prices), finish, quantity, and the specified manufacturer and model if the drawings name one.

## 2. Search the whole shelf at once

```
match_materials(catalog_id="", [ ...requirements ])
```

`catalog_id=""` searches every indexed catalog and names the vendor carrying each candidate.
Feed it the item as the drawings describe it, including size, finish and mounting — longer,
more specific requirements match better, not worse.

Read the result carefully:

| Result | Means | Do |
|---|---|---|
| `matched: true` | candidates found | `lookup_product` each, pin size + finish |
| `found_in_page_text` | in that catalog, on pages the row parser cannot read | `get_page` there, read it yourself, tag `[catalog-page]` |
| `related_but_wrong_section` | shares wording, different CSI section | **not an answer** — a partition-mounted dispenser is not a partition |
| none of these | not on the shelf | record the gap; do not invent a model |

**Never read a `text_only` catalog's silence as "this vendor does not carry it."** On this
shelf that would wrongly write off NUDO and World Dryer entirely.

## 3. Hand dryers

World Dryer is a Level-3 account at `0.339`, but **its actual price list is an `.xlsx` that
`catalog-intelligence` cannot read** — the indexed PDF is only a pricing memo. Cost has to be
entered by hand from the spreadsheet. Tag the line `[not indexed]` and say the price came
from a file that was opened manually. ASI carries dryers too and *is* indexed; Dyson and
Excel XLERATOR are quoted but not on the shelf.

## 4. Gaps this shelf cannot fill

No indexed vendor covers these. Declare them plainly — a stated gap is a real deliverable,
not a failure:

- **Toilet partitions — 10 21 13** · `[not carried on shelf — outside RFQ required]`
- **Lockers — 10 51 00** · `[not carried on shelf — outside RFQ required]`
- **Fire extinguisher cabinets — 10 44 00** · `[not carried on shelf — outside RFQ required]`

Do not name a recommended outside vendor. CBC lost access to Scranton (requirements 2.2) and
has not named a replacement — recommending one would be inventing a supply route.

Log each into `pending_vendor_rfqs` in `memory/active_project.json`. If partitions are
priced later from an outside quote, they carry the 35% restroom-partitions band.

## 5. Price it

Multipliers: ASI `0.375` (list) · Bobrick and Gamco `1.0` (**Net Cost Each** — the columns
are already net) · Bradley `0.53` (list) · World Dryer `0.339` (list, manual entry).

Margin: `get_margin_band("accessories", customer)` — 56%, or 45% on Wendy's.

Then `calculate_quote_line(...)` with `cost_source` and `cost_source_detail`.

## 6. Confidence and verification

`HIGH` exact model, mounting and size confirmed · `MEDIUM` an equivalent substitute is
proposed (say so, and that substitution normally needs approval) · `LOW` mounting ambiguous
or size not stated.

Then, one call per source:

```
verify_facts(doc_id,     [ quantities, tags, locations ])
verify_facts(catalog_id, [ models, finishes, prices ])
```

Anything `verified: false` is deleted, not rephrased.
