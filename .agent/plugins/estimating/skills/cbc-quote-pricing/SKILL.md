---
name: cbc-quote-pricing
description: Cost a takeoff line and compute its sale price - the four CBC sourcing paths in order, cost freshness, vendor multipliers, margin bands and overrides, and sales tax.
---

# CBC quote pricing

Phase 4 work. A line becomes a quote line when it has a **quantity** (from the drawings), a
**cost** (from one of the four paths below), and a **margin** (from the band, possibly
overridden). Everything else is computed.

## 1. Source the cost — in this order

CBC has four routes and they are tried in this order (requirements 6.2 / FR-6). Record which
one produced the number; a line that cannot name its path does not go in a proposal.

### `p21_last_po` — the last purchase-order price
For regularly bought items. **Never** P21's supplier-list or supplier-cost fields —
purchasing does not keep them current. Check the age:

```
check_cost_freshness(cost_date)
```

`fresh` under a year (usable, provided no price increase landed) · `review` one to two years
(check the vendor first) · `stale` two to three · `discard` beyond that. A discarded cost is
re-sourced, not used with a caveat.

### `manual_wholesaler_net` — bought through a distributor
Allegion lines (Von Duprin, LCN, Schlage, Ives) come through **Banner Solutions** or
**SecLock**; some accessories through **J2**; laminate doors through **Pionite** or
**Wilsonart**. `lookup_vendor_multiplier` returns `multiplier: None` and
`action_required: MANUAL_PRICE_ENTRY` for all of them. Prompt:

> Line [item] requires a net cost from [wholesaler]. Enter the distributor net, or mark the
> line "awaiting vendor quote".

Note that margin usually drops on these — the cost is higher than a direct buy.

### `catalog_list_x_multiplier` — list price × CBC's tier
```
match_materials(catalog_id="", [ ...requirements ])   # whole shelf in one pass
lookup_product(catalog_id, model)                     # the exact (size, finish) row
lookup_vendor_multiplier(vendor)                      # the tier
```

A model does not have one price — Hager `1251` runs $53.44 to $90.13 across sizes and
finishes. Quote the row whose size and finish match the drawings; if the drawings do not pin
one, report the range and say so.

Show the arithmetic and cite the book: `"Hager PB#18 p42, list $256.31 x 0.29 = $74.33,
eff 2026-03-02"`.

### `vendor_rfq` — live quote from the vendor
Custom sizes (a 9-ft door), unusual preps, options not sold in years. Mark the line
`awaiting vendor quote`, register it in `pending_vendor_rfqs`, and carry on with the rest of
the takeoff — an RFQ does not block the other lines.

## 2. Multiplier tiers

Hager `0.29` · ASI `0.375` · Bradley `0.53` · Pemko/Markar `0.45` · NGP `0.45` ·
Rockwood `0.55` · World Dryer `0.339` · **Bobrick and Gamco `1.0` — those columns are
already Net Cost Each** · NUDO direct rows.

Always through `lookup_vendor_multiplier(vendor)`; it resolves the way a drawing actually
writes a vendor ("NGP", "Markar", "Assa Abloy") onto the right tier.

A multiplier that `open_catalog` reports as `multiplier_in_filename` came from a **file
name**, not a document. Confirm it against the vendor's own sheet before applying it.

**World Dryer's real price list is an `.xlsx`, and it IS indexed** — the PDF beside it is
only a memo, so look the model up rather than hand-entering it. Spreadsheet rows carry
`price_basis`: a row that is already net is a cost, and the `0.339` multiplier must not be
applied on top of it. `.xls`, `.docx` and `.msg` on the shelf remain unreadable and are the
only things `[not indexed]` should now be claimed for.

## 3. Margin

```
get_margin_band(product_category, customer, override_margin, override_reason)
```

Commodity 27% · restroom partitions 35% · washroom accessories 56% · specialty (laminate,
special wood doors) 40% · custom-built via outside fabricator 25%.

Category matching is specific-first: *"custom laminate door"* is a custom fabrication at
25%, not a commodity door at 27%.

Margin is an **editable default**, overridable on essentially every quote by how the line
was sourced. A Banner/SecLock buy carries less margin because the cost is higher — pass
`override_margin` with a reason and the deviation is recorded on the line.

**Wendy's** is the only confirmed customer programme: 22% commodity, 45% accessories. No
other account's margins have been supplied (NR-9) — ask the estimator rather than inventing
one.

## 4. Compute

```
calculate_quote_line(cost, margin, quantity, cost_source, cost_source_detail)
```

Never do this arithmetic in your head. `cost_source` must be one of
`catalog_list_x_multiplier` · `p21_last_po` · `manual_wholesaler_net` · `vendor_rfq` ·
`custom_fabricator`; the tool rejects anything else, and `format_cbc_proposal` refuses a
package whose lines lack a source and a detail.

`cost_source_detail` is the citation: `"Hager PB#18 p42, 0.29 mult, eff 2026-03-02"`,
`"P21 PO 88213, 2026-03-14"`, `"Banner quote #12345"`.

## 5. Adders that are not in the price book

Electrification (ELR/RX), non-removable-pin hinges, and premium or lead-time finishes carry
adders the base book does not show cleanly. **CBC has not supplied the values** (NR-7).
Find them with `search_catalog` + `get_page` on the Hager book, or prompt the estimator.
Never quote an adder from memory.

## 6. Tax and terms

Ohio ~8.0% · Kentucky 6.5% · all other 48 states and Canada 0% (supply-only sale to a GC).
Freight is carried **TBD, excluded at estimate stage** — it is priced when a quote becomes a
job. Full terms in the `cbc-estimating-rules` rule.
