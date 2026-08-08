---
name: estimate-proposal-generator
description: Phase 6 - assemble the draft proposal. Doors grouped by opening, accessories block, FRP block, freight line, alternates, tax and CBC's standard terms.
---

# Draft proposal (Phase 6)

## 1. Run the audit gate first

```
format_cbc_proposal(project_name, door_lines, accessories_lines, frp_lines,
                    alternates_lines, state)
```

It checks every line for `cost_source` and `cost_source_detail` before it totals anything.
If `audit_passed` is `false`, the package comes back **NOT READY** with the specific lines
listed in `audit_failures`. Fix those — go back and source the line properly. Do not
assemble the proposal by hand around the gate; the gate is the last point before a number
reaches a person.

## 2. Structure

**Header** — project name and location, customer / GC, the internal initiator who raised the
request, date, 30-day validity, and the status line **"DRAFT — For CBC Estimator Review"**.

**Division 08, grouped by opening** (FR-7). Per door: tag, size and handing, fire rating,
frame throat and wall type, the hardware set broken out with dual finish codes, unit sale
and opening subtotal, and the cost-source citation on every priced component.

**Division 10, as its own block.** Tag, description, mounting, finish, vendor and model,
quantity, unit sale, extended sale. Uncarried lines appear here as
`[not carried on shelf — outside RFQ required]` with no vendor named — in the proposal, not
in a footnote.

**Division 06 FRP, if any.** Sheets, division bars, corner mouldings, end caps, adhesive,
rivets. Carry the provisional-constants flag: the quantities rest on assumptions CBC has not
confirmed (Open Item 5).

**Freight** — a visible line reading `TBD / excluded at estimate stage`. Freight is priced
when a quote becomes a job (Open Item 1). A missing line reads as "included"; the line
prevents that.

**Base bid and alternates.** Base subtotal, tax, grand total. Alternates listed separately
with their own tax and a net delta against the base — never folded into the base subtotal.
CBC has not confirmed how they reconcile alternates and addenda (4.1 / FR-14), so say the
treatment is provisional and raise it as an RFI.

**Terms** — supply-only material F.O.B. factory/warehouse, installation by others; Hamilton
Parker PO required subject to credit approval; 30-day validity; freight TBD. Tax: Ohio ~8%,
Kentucky 6.5%, all other states and Canada 0%.

**Open questions** — the RFI register, unpriced RFQ lines, and everything the estimate could
not confirm.

## 3. Deliver and archive

The proposal goes to the **estimator**, and from there to whoever raised the request
(requirements FR-10 — the named initiator in the queue, not a group email). Nothing is sent
to a customer from here.

Then:

1. Write `memory/prior_quotes/<project-slug>.json` — the payload plus `brand`, `architect`,
   `gc`, so Templated Mode can find it next time.
2. `okf_learn_from_quote(door_lines, brand=...)` to reinforce the patterns this bid used.
3. Update `memory/active_project.json` with the final subtotals and `phase_completed: 6`.
