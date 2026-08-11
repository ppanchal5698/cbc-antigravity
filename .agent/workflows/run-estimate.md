---
name: run-estimate
description: Run the full CBC commercial estimate on a bid set in plans/ - Phase 0 Intake through Phase 6 Draft Proposal.
---

# Run a full CBC estimate

Run CBC's confirmed Phase 0–6 estimating process end to end on the bid set in `plans/`, and
deliver a draft proposal for estimator review.

Follow [`cbc-master-workflow`](../plugins/estimating/skills/cbc-master-workflow/SKILL.md) exactly.
Read it before you start. The phase gates and guardrails in `.agent/rules/cbc-phase-gates.md`
bind every step.

$ARGUMENTS

## Do this

**Phase 0 — Intake.** `open_plan_set` every PDF in `plans/`. `plan_overview`.
`list_catalogs`. Report disciplines, sheet counts, sheets needing a vision pass, which
vendors cover this scope and which part of it nobody covers — *before* doing the work.

**Phase 1 — File setup.** Pick templated vs one-off. `okf_query("brand_package", <customer>)`.
Write the job record to `memory/active_project.json` with `phase_completed: 1`.

**Phase 2 — Spec scoping.** Read the G-series specs. Pull the hardware set schedule — that
is the authority for what each opening requires. Capture fire ratings. Declare in-scope and
out-of-scope trades explicitly.

**Phase 3 — Take-offs.** Locate first, then read. `find_schedule(doc_id, kind)` for `door`,
`hardware`, `accessory` and `finish` — never guess a sheet number, numbering is a per-firm
convention. Clear `plan_overview`'s `vision_outstanding` before taking a quantity off any
sheet: a count that exists only as tags, and a size the schedule leaves to the elevation,
are not in the text layer.

Then `read_schedule` on what discovery returned, never flat text. Enumerate every row and
report the tags exactly as they appear — numbering skips. Decode the hardware schedule's
column headers so each opening's X marks resolve to the specific product specified.
`parse_door_size`, `calculate_frame_throat`. For Division 10, accessories are often keynotes
rather than a schedule — fall back to `read_layout` and `render_sheet`, and check
`absence_established` before reporting anything as absent. Record a `quantity_source` and a
`size_source` on every line; `format_cbc_proposal` rejects lines without them.

**Phase 3b — FRP.** Perimeter, height, corners → `calculate_frp_takeoff`. Carry its
`provisional` flag onto every FRP line.

**Phase 4 — Pricing.** Cost each line in order: P21 last-PO (check with
`check_cost_freshness`) → wholesaler net (prompt me) → catalog list × multiplier → vendor
RFQ. `lookup_product` for the exact (model, size, finish) row — check `get_page` when the
parsed rows are missing sizes. `get_margin_band` then `calculate_quote_line`. Every line
records `cost_source` and `cost_source_detail`.

**Phase 4b — Alternates.** Separate groups, net delta, and an RFI on the process itself.

**Phase 5 — Judgment.** Reuse the closest prior quote. Label every substitution as a
substitution requiring approval. Register every RFI.

**Phase 6 — Deliver.** `format_cbc_proposal`. If `audit_passed` is false, fix the lines it
names — do not work around the gate. Archive to `memory/prior_quotes/`, run
`okf_learn_from_quote`, update the job record.

Then run [`estimate-quality-gate`](../plugins/estimating/skills/estimate-quality-gate/SKILL.md)
over the whole thing before showing me anything.

## Do not

- Do not read a schedule from flat sheet text.
- Do not invent an opening tag, model number, price, adder value or multiplier.
- Do not present CBC's reference hardware set as what the drawings call for.
- Do not price an aluminium storefront, overhead door, tile, masonry or plumbing fixture —
  those are out of CBC's scope. Exclude them visibly.
- Do not read a `text_only` catalog's silence as "this vendor does not carry it."
- Do not complete a specialist handoff by inventing missing `verified_against_*`,
  `cost_source`, or citations — send incomplete work back or raise an RFI.
- Do not send anything to a customer. Every output is a draft for the estimator.

## Deliver

A draft proposal with: doors grouped by opening with subtotals · a separate Division 10
accessories block · an FRP block if applicable · a freight line carried TBD · alternates
separated with net deltas · CBC's standard terms · tax by state (OH ~8%, KY 6.5%, 0%
elsewhere).

Every line cites its plan sheet and its catalog page, tagged `[schedule]` `[spec]` `[note]`
`[drawing]` `[catalog]` `[catalog-page]` `[not carried]` `[not indexed]` `[not stated]`.

Close with the RFI register and everything you could not confirm.
