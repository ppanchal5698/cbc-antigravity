---
name: cbc-estimating-rules
description: CBC quote math, margin framework, vendor multiplier tiers, commercial terms and tax, frame throat sizes, and finish nomenclature. Reference data for every priced line.
trigger: always_on
---

# CBC estimating reference rules

Companion to `cbc-phase-gates`. That rule says *when*; this one says *with what numbers*.

## Quote math — three manual inputs

Only three values per line are human: **Quantity** (from the take-off), **Our Cost** (from
the sourcing order), **Margin** (from the band below). Everything else is computed:

```
Sale $ EA = Cost / (1 - Margin)      Ext Sale = Sale $ EA x Qty
Ext Cost  = Cost x Qty               Ext Margin $ = Ext Sale - Ext Cost
```

Always via `calculate_quote_line(cost, margin, quantity, cost_source, cost_source_detail)`.
Unit weight is a dead field from the truck-loading era — CBC removed it; do not reintroduce it.

## Margin framework

| Category | Margin | Divisor |
|---|---|---|
| Commodity — doors, HM frames, stock hardware | 27% | 0.73 |
| Restroom partitions | 35% | 0.65 |
| Washroom accessories | 56% | 0.44 |
| Specialty — laminate / special wood doors | 40% | 0.60 |
| Custom-built via outside fabricator | 25% | 0.75 |

Margin is an **editable default, overridable on essentially every quote by sourcing**
(requirements 6.1 / FR-5). A line bought through Banner/SecLock at a higher cost carries a
lower margin. Pass `override_margin` and `override_reason` to `get_margin_band` and the
override is recorded on the line.

Confirmed customer program: **Wendy's** — 22% commodity, 45% accessories. No other account's
margins have been supplied (NR-9). Do not invent one; ask the estimator.

## Vendor multipliers

| Vendor | Multiplier | Basis |
|---|---|---|
| Hager | 0.29 | list ('50 & 42' tier, ~75% of hardware volume) |
| ASI | 0.375 | list |
| Bradley | 0.53 | list (WAD tier) |
| Pemko / Markar | 0.45 | list (buying program acct 4244636) |
| National Guard Products | 0.45 | list |
| Rockwood | 0.55 | list (accessories book) |
| Bobrick / Gamco | 1.0 | **net cost each** — the columns are already net |
| World Dryer | 0.339 | list (Level 3) |
| NUDO | direct | sheet and moulding rows priced as listed |

Always via `lookup_vendor_multiplier(vendor)` — it resolves aliases and flags the
wholesalers. Never present a list price as a cost. Show the arithmetic and cite the book
and effective date whenever a net number is quoted.

A multiplier read off a **file name** (`open_catalog` reports it as
`multiplier_in_filename`) is a routing hint, not an authority. Confirm it against the
vendor's own sheet — `HAGER/Hager Multipliers and Special Nets`, `BOBRICK/Multiplier.docx` —
before applying it.

**Manual entry required**, no multiplier exists: Banner Solutions, SecLock, J2 Specialties,
Pionite, Wilsonart. Prompt the estimator for the distributor net or mark the line
`awaiting vendor quote`.

## Adders — not in the price book

Electrification (ELR/RX), non-removable-pin hinges, and premium / lead-time finishes carry
adders that the base price book does not show cleanly (requirements 6.3). **CBC has not
supplied the values** (NR-7). Look them up in the Hager price book with
`search_catalog` + `get_page`, or prompt the estimator. Never quote an adder from memory.

## Commercial terms and tax

- Supply-only material, F.O.B. factory / CBC warehouse. Installation by others.
- Hamilton Parker PO required, subject to credit approval.
- Quote valid 30 days.
- Freight carried **TBD / excluded at estimate stage** — it is priced when a quote becomes
  a job, not now.
- Sales tax: **Ohio ~8.0%**, **Kentucky 6.5%** (border nexus). All other 48 states and
  Canada **0%** — the sale is to a GC or corporation, not an end customer.

## Frame throat by wall type

`5-5/8"` 3-5/8" stud + 1/2" drywall (common at McDonald's) · `5-7/8"` 3-5/8" stud + 5/8"
Type X drywall (standard commercial) · `5-3/4"` masonry / CMU · `7-3/4"` wood stud ·
`8-1/4"` 6" metal stud + 5/8" drywall. Derive via `calculate_frame_throat`. These five cover
most work; a custom depth is a manual entry, and adjustable frames exist.

## Hardware sets

There is **no single standard hardware list** (requirements 7.2). Architects specify by part
number and series — Hager 3400 vs 3500 is grade 1 vs grade 2 — and the spec's hardware
schedule is the authority for what is required (7.7). Read the spec's set definition first
and quote those part numbers, reconciled to CBC's stock lines.

`expand_hardware_set` returns CBC's **reference** set. It is a fallback for when the spec
defines no set, and its output is always tagged for estimator confirmation. Never present it
as what the drawings call for.

Beyond the stock top-N there is a deliberate **manual cut-off** (NR-13): do not try to price
every option permutation. Hand the long tail to the estimator.

## Finish nomenclature

Two systems are in use and both must be read: `US26D` = `626`, `US32D` = `630`,
`US10B` = `613`, `US3` = `605`, `US19` = `622`, `USP` = `600`, `US15` = `619`. Translate with
`convert_finish_code` and flag premium finishes for lead time and adder review.

## Audit trail

Every fact in a proposal carries its source. Plan facts cite sheet number and a source tag
(`[schedule]` `[spec]` `[note]` `[drawing]` `[not stated]`); catalog facts cite vendor, page,
basis and multiplier (`[catalog]` `[catalog-page]` `[not carried]` `[not indexed]`). Gaps are
stated, never filled.
