# cbc-estimating-engine

Deterministic estimating math and reference data for Construction Building Components (CBC),
a division of The Hamilton Parker Company. Exposed over MCP so the estimating workflow never
has to do arithmetic in its head.

## Design rule: this server holds no prices

Prices come from `catalog-intelligence`, from P21's last-PO price, or from a vendor quote.
This engine holds formulas, multiplier tiers, margin bands, and reference model numbers. A
value CBC has not confirmed is marked `PENDING_CBC_DATA` and returned as such rather than
guessed — that applies to the Hager adders (NR-7), special-customer margins beyond Wendy's
(NR-9), and the FRP conversion constants (Open Item 5).

## Tools

**Quote math**
- `calculate_quote_line` — `Sale $ EA = Cost / (1 - Margin)`, extensions, effective margin.
  Rejects an unrecognised `cost_source`.
- `check_cost_freshness` — classifies a P21 last-PO cost: fresh / review / stale / discard,
  on CBC's 1-year / 2-year / 3-year thresholds.
- `get_margin_band` — commodity 27% · partitions 35% · accessories 56% · specialty 40% ·
  custom 25%, with the Wendy's programme and per-line `override_margin`.
- `lookup_vendor_multiplier` — Hager 0.29 · ASI 0.375 · Bradley 0.53 · Pemko/NGP 0.45 ·
  Rockwood 0.55 · World Dryer 0.339 · Bobrick/Gamco 1.0 **net**. Resolves the aliases a
  drawing actually uses ("NGP", "Markar") and flags wholesalers `MANUAL_PRICE_ENTRY`.

**Reference data**
- `convert_finish_code` — US ↔ BHMA both directions, premium finishes flagged.
- `calculate_frame_throat` — the five standard throats from wall construction.
- `parse_door_size` — `3070` → 3'-0" x 7'-0".
- `expand_hardware_set` — CBC's **reference** grouping, tagged
  `requires_estimator_confirmation`. The spec's own hardware schedule outranks it.
- `calculate_lite_louver_price` — the lookup route for NGP / Pemko / Rockwood lite tables.
- `calculate_frp_takeoff` — sheets, trims, adhesive, rivets. Returns `provisional: true`;
  the conversion constants are assumptions, not CBC's.

**Assembly**
- `format_cbc_proposal` — Phase 6 draft. Audits every line for `cost_source` and
  `cost_source_detail` and returns `audit_passed: false` with the offending lines rather
  than totalling unsourced work. Freight carried TBD; alternates kept separate; tax OH ~8%,
  KY 6.5%, 0% elsewhere.
- `route_model_for_task` — effort tier (routine / deliberate / visual). Guidance only; model
  selection belongs to the user.
- `execute_sandbox_script` — runs agent Python in `sandbox/` behind the write guard.

**OKF knowledge graph** (`okf.py`)
- `okf_query` — `brand_package` · `frame_throat` · `vendor_substitution` · `uncarried`
- `okf_hardware_set` · `okf_learn_from_quote` · `okf_learn_from_correction` ·
  `okf_graph_status`

The graph records which product, never what it costs; `validate()` rejects a price field on
a `CatalogProduct` node.

## Tests

```bash
../../../.venv/Scripts/python.exe -m pytest . -q
```

`TestGuardrails` and `TestOKFKnowledgeGraph` are regressions for the 2026-08 audit — each
one failed before its fix. They run against shipped code and clean up after themselves.
