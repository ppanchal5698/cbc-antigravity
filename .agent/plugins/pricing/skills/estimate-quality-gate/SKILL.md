---
name: estimate-quality-gate
description: The check to run before a takeoff or draft proposal is shown to anyone - phase prerequisites, math invariants, grounding, scope containment, and what a specialist subagent must hand back.
---

# Estimate quality gate

Run this before any takeoff or draft leaves your hands, and on anything a specialist
subagent returns. It is the thing that catches a confident wrong answer while it is still
cheap.

## 1. Phase prerequisites

Work the phases in `cbc-phase-gates` in order. Before accepting a deliverable, check the
phase that produced it actually had what it needed:

| Producing | Requires |
|---|---|
| Scope declaration | a `doc_id` per plan PDF and the shelf's coverage |
| Schedules | the spec's hardware sets read, in-scope and out-of-scope declared |
| Takeoff | schedules read with `read_schedule`, not flat text |
| Pricing | every item enumerated with tag, quantity, size, finish |
| Proposal | every line has cost, cost_source, margin, sale_ea, ext_sale |

A deliverable produced without its prerequisite is not a shortcut, it is a guess. Say which
prerequisite is missing and go get it.

## 2. Math invariants

Check each priced line, to the cent:

```
sale_ea   == round(cost / (1 - margin), 2)
ext_sale  == round(sale_ea * quantity, 2)
ext_cost  == round(cost * quantity, 2)
```

Any deviation means the number was worked out rather than computed. Recompute with
`calculate_quote_line` and use that result — do not reconcile by adjusting the margin.

## 3. Grounding

Every plan fact through `verify_facts(doc_id, [...])`. Every catalog fact through
`verify_facts(catalog_id, [...])`, once per book it came from. A fact verified in one
document is not verified in another.

`verified: false` means **not in that document**. Delete it or replace it with the
document's own wording from `near_miss`. Never restore it from product knowledge.

Watch for these specifically, because they are what a confident model supplies unprompted:

- a product line name because the manufacturer is right
- a gauge, alloy or finish grade the spec does not state
- a dimension "typical" for that assembly
- an opening tag that would fill a gap in a numbering sequence
- an adder value, a multiplier, or a price

## 4. Scope containment

Scan every line's description for: tile · masonry · brick · framing labour · storefront ·
curtain wall · overhead or coiling door · plumbing fixture · faucet · HVAC · duct ·
electrical · ceiling grid. Anything matching is out of CBC's scope — remove it and list it
under exclusions, so the reader can see it was considered and dropped rather than missed.

## 5. Retry limit

Two attempts at any lookup or verification. On the second failure, stop: log it as an
`UNRESOLVED_RFI` or `MANUAL_PRICE_ENTRY`, and continue with the rest of the takeoff. Never
loop, and never let a failed lookup become a guess.

## 6. What a specialist must hand back

When delegating to `door-hardware-estimator`, `specialties-estimator` or
`pricing-calculator`, give it the `doc_id`, the sheet numbers, and the project mode — and
require these fields back.

**Door line**
```json
{
  "tag": "101", "door_size": "3070", "width_in": 36.0, "height_in": 84.0,
  "handing": "LH", "wall_type": "W1", "frame_throat": "5-7/8\"",
  "fire_rating": "20 MIN", "hardware_set": "HW-1",
  "hardware_set_source": "spec_schedule | cbc_reference_set",
  "finish_code": "626 (US26D)", "verified_against_plan": true,
  "sheet_citation": "A2.2 [schedule]"
}
```

**Accessory line**
```json
{
  "item_tag": "TA-1", "description": "Surface mounted paper towel dispenser",
  "mounting": "surface", "specified_mfr": "Bobrick", "specified_model": "B-262",
  "proposed_vendor": "Bobrick", "proposed_model": "B-262", "is_substitution": false,
  "quantity": 2, "verified_against_catalog": true,
  "sheet_citation": "A6.1 [schedule]", "catalog_citation": "Bobrick 2020 p12 [catalog]"
}
```

**Priced line**
```json
{
  "cost": 150.00, "margin": 0.27, "quantity": 2,
  "sale_ea": 205.48, "ext_sale": 410.96, "ext_cost": 300.00,
  "cost_source": "catalog_list_x_multiplier",
  "cost_source_detail": "Hager PB#18 p42, 0.29 mult, eff 2026-03-02",
  "confidence": "HIGH"
}
```

A payload missing `verified_against_*`, `cost_source` or its citation is incomplete. Send it
back rather than filling the gap yourself.

## 7. Before you answer

- Is every number computed by the engine?
- Is every fact verified against the document it came from?
- Is every gap stated rather than filled?
- Does every gap use `[not stated]`, `[not indexed]`, or `[not carried]`?
- Is every substitution labelled as one?
- Are incomplete specialist payloads returned to the specialist (or raised as RFIs),
  never silently completed with invented fields?
- Does the output say **"Draft Proposal for Estimator Review"**?
- Does it close with what could not be confirmed?
