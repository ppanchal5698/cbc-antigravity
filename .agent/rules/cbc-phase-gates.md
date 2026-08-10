---
name: cbc-phase-gates
description: CBC's confirmed Phase 0-6 estimating process, the exit gate on each phase, and the anti-rogue guardrails that bind every estimate. Authority is docs/requirements.md v1.3.
trigger: always_on
---

# CBC estimating process — phases and gates

The phases below are CBC's own current-state process, confirmed by the estimators on
14 Jul (`docs/requirements.md` § *Process Flow*). Use these names and this order. Do not
invent a different phase model.

| Phase | What happens | Exit gate |
|---|---|---|
| **0 — Intake** | Receive the bid request; note alternates and the bid-due date. `open_plan_set` on each PDF (a bid may be one combined file or several). `list_catalogs` to confirm the shelf. | `doc_id` for every plan PDF; shelf coverage reported |
| **1 — File setup** | Create the job record in `memory/active_project.json`: project, customer/initiator, mode, and **the project's site address and state read off the cover sheet** — the site, not the franchisor's or architect's office, which sit in the same title block. Templated mode reads the closest match in `memory/prior_quotes/`; one-off starts blank. | Job record written with `phase_completed: 1`; `state` present and cited to a sheet |
| **2 — Spec scoping** | Read the specification (G-series) for the Div 08 and Div 10 scope, fire ratings, and the hardware-set schedule. Declare out-of-scope trades now. | In-scope and out-of-scope both stated explicitly |
| **3 — Drawing review & take-offs** | **`find_schedule(doc_id, kind)` to locate — never guess a sheet number. `plan_overview` first: every sheet in `vision_outstanding` gets `render_sheet` + `record_vision_reading` before any quantity is taken off it.** Then `read_schedule` on what discovery returned — never flat text. Enumerate openings, accessories, sizes, handing, rating, wall types. Quantities come from the drawings only. | `vision_outstanding` empty; every item enumerated with tag, qty, size, finish and a `quantity_source`; `verify_facts` clean |
| **3b — FRP take-off** | Perimeter LF, wall height, inside/outside corners → `calculate_frp_takeoff`. | Quantities produced, provisional-constants flag surfaced |
| **4 — Pricing & build** | Cost each line by the sourcing order below, apply the margin band, `calculate_quote_line`. | Every line has cost, cost_source, margin, sale_ea, ext_sale |
| **4b — Alternates & addenda** | Base bid and alternates priced as separate, comparable groups. **CBC has not confirmed this process** (Open Item 11) — raise it as an RFI rather than assuming a method. | Base and alternates kept separate; RFI raised |
| **5 — Judgment, reuse & RFIs** | Reuse the closest prior quote. Handle direct-equal substitution: propose the closest of the top 2-3 brands with a note saying it is a substitution requiring approval. Register every RFI. | RFI register complete; substitutions labelled |
| **6 — Deliver** | `format_cbc_proposal` → draft grouped by door, separate accessories block, FRP block, freight line (TBD), standard terms. Deliver to the estimator, never to a customer. | Subtotals synced to the job record, `phase_completed: 6` |

**Do not skip forward.** If a phase's gate is unmet, say which gate and what is missing
rather than producing the downstream deliverable anyway.

**A sheet number is not an address.** Every set CBC receives is numbered differently, and
some carry no parseable sheet number at all. Find content by what it says —
`find_schedule(doc_id, kind)` — not by where it sat in the last set. A number that does not
resolve returns `did_you_mean` with this set's own numbering: read it and search, do not
guess again. And "no candidates" only means absent when `absence_established` is true;
until every sheet has been read, silence is silence.

**A schedule is not the whole drawing.** A CAD sheet's text layer flattens columns from
unrelated tables into one stream, and it cannot see a tag count, a dimension or a revision
cloud at all. When a schedule row states no quantity or no size — Dutch Bros A1.2 says
`SIZE DEPENDANT ON INSTALLATION LOCATION` — the number lives on the plan or the elevation
and must be read there. Do not default a quantity to 1, and never infer a size from the
product's usual sizes. Record where each number came from in `quantity_source` /
`size_source`; `format_cbc_proposal` rejects a line without them.

## Cost sourcing order (requirements 6.2 / FR-6)

Try in this order and record which one produced the cost:

1. **P21 last purchase-order price** — for regularly bought items. Never the supplier
   list/cost fields; purchasing does not keep them current. Check freshness: under a year is
   good, 6–8 months is suspect, 3–4 years must be discarded.
2. **Wholesaler net** — Allegion lines (Von Duprin, LCN, Schlage, Ives) come through Banner
   Solutions or SecLock; accessories sometimes through J2; laminate doors through
   Pionite/Wilsonart. These require **manual estimator entry** — prompt, do not guess.
3. **Catalog list × vendor multiplier** — via `catalog-intelligence` and
   `lookup_vendor_multiplier`. Show the arithmetic and cite the book and effective date.
4. **Vendor RFQ** — custom sizes, unusual preps, never-sold options. Mark the line
   `awaiting vendor quote` and carry on with the rest of the takeoff.

Every line records `cost_source` and `cost_source_detail`. A line without them does not go
into a proposal.

## Guardrails

**Grounding.** Quantities come from the drawings, prices and model numbers from the price
books, and nothing comes from your own product knowledge. Run `verify_facts` on both
servers before reporting. A claim that comes back `verified: false` is deleted, not
rephrased. Never invent an opening tag, a model number, a price, or an adder value.

**Deterministic math.** All arithmetic goes through `cbc-estimating-engine`. Never compute a
sale price, extension, or tax in your head. Check each line satisfies
`sale_ea == round(cost / (1 - margin), 2)` and `ext_sale == round(sale_ea * qty, 2)` within
a cent; if not, recompute with the engine rather than accepting the number.

**Scope containment.** If a takeoff line lands on tile, masonry, framing labour, storefront,
overhead doors, plumbing fixtures, HVAC or electrical, drop it and note the exclusion.

**Circuit breaker.** Two attempts at any lookup or verification. On the second failure stop,
log it as an RFI or `MANUAL_PRICE_ENTRY`, and move on. Never loop.

**Estimator sovereignty.** Every output is a *draft for estimator review*. Nothing is sent,
finalised, or committed to a customer. Estimator overrides are appended to
`memory/corrections.jsonl` and outrank every automated match.

## Items CBC has not confirmed

Treat these as open, not as rules. Where one is in play, raise an RFI and say it is
unconfirmed: **fire rating** — where it lives on bids and which categories price on it
(7.3 / Open Item 9); **alternates & addenda** reconciliation (4.1 / FR-14 / Open Item 11);
**FRP conversion constants** (Open Item 5); **Hager adder values** for electrification, NRP
and premium finishes (NR-7); **special-customer margins** beyond Wendy's (NR-9).
