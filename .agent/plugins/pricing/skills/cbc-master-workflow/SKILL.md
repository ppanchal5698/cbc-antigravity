---
name: cbc-master-workflow
description: End-to-end CBC commercial estimating, Phase 0 Intake through Phase 6 Deliver. Use whenever a bid set lands in plans/ or the user asks for a full takeoff, estimate, or material proposal for a commercial building.
---

# CBC master estimating workflow

The phases below are CBC's own process, confirmed by Kevin, Rick and Shanna on 14 Jul
(`docs/requirements.md` § *Process Flow*). Use these names and this order.

Two things hold throughout: **the estimator stays in control** — this drafts, sources and
calculates, it does not send — and **every fact is verified against the document it came
from** before it goes in an answer. `verify_facts` is the exit gate on every phase, not a
phase of its own.

---

## Phase 0 — Intake

A bid arrives by email with plans and an RFP attached, sometimes as one combined PDF and
sometimes as several. Occasionally it arrives by phone, in which case there is no PDF and
the job record is opened by hand.

1. `open_plan_set(pdf_path)` on **every** PDF in `plans/` — a bid split across files is
   normal. Keep each `doc_id`.
2. `plan_overview(doc_id)` — disciplines, sheet ranges, and which sheets need a vision pass.
3. `list_catalogs()` — what is on the shelf and each book's `coverage`.
4. Note the **bid-due date** and any **bid alternates** now; both come from the RFP, not the
   drawings.
5. Report the scope of the work before doing any of it: disciplines and sheet counts, how
   many sheets need vision, which vendors can answer this division, and which part of it
   nobody on the shelf covers.

**Gate:** a `doc_id` for every plan PDF, and the shelf's coverage stated.

## Phase 1 — File setup

CBC copies a prior job workbook (templated) or starts from a blank one (one-off). The
equivalent here is the job record.

1. Decide the mode. **Templated** — the project is a known brand account; check
   `memory/prior_quotes/` for the closest prior bid and use it as the starting draft.
   **One-off** — build from scratch.
2. `okf_query("brand_package", "<customer>")` for the brand's programme margins, preferred
   hardware sets and standard throat. A brand whose margins CBC has not supplied comes back
   `PENDING_CBC_DATA` — use the standard bands and say so.
3. Write `memory/active_project.json`: project name, initiator, `plan_doc_id`, state, mode,
   `phase_completed: 1`.

**Gate:** the job record exists and names its mode.

## Phase 2 — Spec scoping

Read the specification, not the drawings, and establish what is being quoted.

1. Find the G-series specs (`list_sheets(doc_id, discipline="General")`,
   `search_sheets(doc_id, '"SECTION 08" OR "SECTION 10"')`).
2. Pull the **hardware set schedule** — HW-1, HW-2 and what each contains. This is the
   authority for what the openings require (requirements 7.7). Read the set definitions
   now; do not substitute CBC's reference sets for them.
3. Capture **fire ratings** wherever they appear. CBC has not confirmed where ratings live
   in their bid sets (7.3 / Open Item 9) — record what you find and raise it as an RFI
   rather than assuming a convention.
4. **Declare the boundary out loud**: in scope is Div 08 (doors, frames, hardware),
   Div 10 28 (accessories, hand dryers), Div 06 64 (FRP). Out of scope is framing labour,
   tile, masonry, storefront, overhead and coiling doors, plumbing fixtures, HVAC,
   electrical, ceiling grid.

**Gate:** in-scope and out-of-scope both stated; hardware sets read from the spec.

## Phase 3 — Drawing review & take-offs

Quantities come from the drawings and only from the drawings.

1. **Door schedule** — `read_schedule(doc_id, sheet)`, never flat text. Capture per opening:
   tag, size code, door and frame material, wall type, handing, fire rating, hardware group.
   Enumerate every row; numbering skips, and `01, 02, 03, 06` is four doors.
2. `parse_door_size(code)` for widths that drive kick plates, sweeps and thresholds.
3. `calculate_frame_throat(wall_type)`, or `okf_query("frame_throat", "<wall description>")`
   for a learned mapping. Five standard depths cover most work; anything else is a custom
   entry.
4. **Accessories** — Division 10 is often *not* a schedule. Try the vocabularies:
   `"TOILET ACCESSOR*"`, `"GRAB BAR"`, `"DISPENSER"`, `"HAND DRYER"`, `"MIRROR"`,
   `"BABY CHANG*"`, `"PARTITION"`. Fall back to `read_layout` on enlarged restroom plans
   and keynotes, and to `render_sheet` on interior elevations when the count is only visible.
5. **Hardware expansion** — expand each opening from the spec's set definition. Where the
   spec defines no set, `expand_hardware_set` gives CBC's reference list; it comes back
   tagged `requires_estimator_confirmation` and must be presented that way.
6. `cross_reference` every manufacturer, series and finish. Where the spec and a schedule
   disagree, report both and flag it — do not pick one.
7. Anything referenced but never defined (a callout for "GROUP 6" when only 1–4 exist) is a
   finding worth more than a guess.

**Gate:** every item enumerated with tag, quantity, size and finish; `verify_facts(doc_id, …)`
clean on the whole list.

## Phase 3b — FRP take-off

Where FRP is specified (kitchens, food prep, washdown, janitor closets):

1. Capture perimeter LF, wall height, and inside/outside corner counts from the plan.
2. `calculate_frp_takeoff(perimeter_lf, inside_corners, outside_corners, wall_height_ft)`.
3. The result carries `provisional: true` — the conversion constants are working
   assumptions, not CBC's (Open Item 5). Surface that on every FRP line.

**Gate:** quantities produced, provisional flag carried forward.

## Phase 4 — Pricing & build

Cost each line by the sourcing order, then apply the margin, then compute.

1. **Source the cost**, in this order, recording which path produced it:
   - `p21_last_po` — the last purchase-order price for a regularly bought item. Check it
     with `check_cost_freshness(cost_date)`; under a year is good, older needs a price-increase
     check, three years or more is discarded.
   - `manual_wholesaler_net` — Allegion lines (Von Duprin, LCN, Schlage, Ives) via Banner
     Solutions or SecLock; accessories sometimes via J2; laminate doors via
     Pionite/Wilsonart. `lookup_vendor_multiplier` returns `MANUAL_PRICE_ENTRY` for these.
     Prompt the estimator: *"Line [item] needs a net cost from [wholesaler]. Enter it, or
     mark the line awaiting vendor quote."*
   - `catalog_list_x_multiplier` — `match_materials(catalog_id="", [...])` across the whole
     shelf, then `lookup_product` for the exact (model, size, finish) row, then
     `lookup_vendor_multiplier`. Show the arithmetic.
   - `vendor_rfq` — custom sizes, unusual preps, never-sold options. Mark the line
     `awaiting vendor quote` and carry on.
2. **Margin** — `get_margin_band(category, customer)`. It is an editable default: a line
   bought through a wholesaler at higher cost carries a lower margin, passed as
   `override_margin` with a reason.
3. **Compute** — `calculate_quote_line(cost, margin, quantity, cost_source, cost_source_detail)`.
   Never do this arithmetic yourself.
4. **Confidence** (FR-8): `HIGH` exact model and finish matched · `MEDIUM` an equal
   substitution is proposed · `LOW` the drawings omit finish, handing or size.

**Gate:** every line has cost, `cost_source`, `cost_source_detail`, margin, `sale_ea`,
`ext_sale`. `format_cbc_proposal` will refuse the package otherwise.

## Phase 4b — Alternates & addenda

Price alternates as separate, comparable groups with a net delta against the base bid. Never
fold one into the base subtotal.

**CBC has not confirmed how they handle alternates and addenda** (4.1 / FR-14 /
Open Item 11). Do the separation, and raise the process itself as an RFI rather than
inventing a reconciliation method.

## Phase 5 — Judgment, reuse & RFIs

1. **Reuse** — pull the closest prior quote from `memory/prior_quotes/` and reconcile it
   against this takeoff.
2. **Direct equal** — where a specified line is not available, propose the closest of the
   top two or three brands and attach a note saying it is a substitution normally requiring
   GC approval. `okf_query("vendor_substitution", "<specified model>")` for one already
   approved. Never present a substitution as what the drawings call for.
3. **Gaps** — toilet partitions (10 21 13), lockers (10 51 00) and fire extinguisher
   cabinets (10 44 00) are not on this shelf. Declare them
   `[not carried on shelf — outside RFQ required]` without naming a vendor.
4. **RFI register** — every ambiguity: undefined hardware group, missing handing, unrated
   opening, unstated finish, absent dimension.
5. **Corrections** — append every estimator override to `memory/corrections.jsonl`, then
   `okf_learn_from_correction`.

**Gate:** RFI register complete; every substitution labelled.

## Phase 6 — Deliver

1. `format_cbc_proposal(project_name, door_lines, accessories_lines, frp_lines,
   alternates_lines, state)`. It audits every line's cost source and returns
   `audit_passed: false` with the specific failures if any line is unsourced — fix those,
   do not work around them.
2. Run `estimate-proposal-generator` to render it: doors grouped by opening with subtotals,
   a separate accessories block, an FRP block, the freight line (TBD), alternates side by
   side, and CBC's standard terms.
3. Label it **"Draft Proposal for Estimator Review"**. It goes to the estimator and to
   whoever raised the request — never to a customer.
4. Archive to `memory/prior_quotes/<project>.json`, then `okf_learn_from_quote` so the
   patterns reinforce.
5. Update `memory/active_project.json` with the final subtotals and `phase_completed: 6`.

**Gate:** subtotals synced, archive written, learning pass run.

---

## Close every estimate with what you could not confirm

Unpriced RFQ lines, `text_only` catalogs not read page by page, the spreadsheets the server
cannot open (World Dryer's real price list is one), drawings that do not state a finish,
hardware groups with no definition, and every open CBC item the estimate touched.

**A short takeoff that is entirely correct beats a comprehensive one that is 85% correct.**
On construction documents the 15% is what costs money.
