# memory/

Persistent state across estimating sessions. **Data only** — the code that reads and writes
it lives in `.agent/mcp/cbc-estimating-engine/cbc_engine/okf.py` and is reached through the
`okf_*` MCP tools, never by editing these files by hand.

| Path | Holds | Written by |
|---|---|---|
| `active_project.json` | The current job record: plan `doc_id`, phase, extracted schedules, RFIs, pending RFQs, pricing summary | the master workflow, at each phase gate |
| `corrections.jsonl` | Append-only log of estimator overrides | the estimator, then `okf_learn_from_correction` |
| `knowledge_graph/graph.json` | The OKF graph — learned patterns, no prices | `okf_learn_from_quote` / `okf_learn_from_correction` |
| `knowledge_graph/schema.json` | The ontology, validated on load | by hand, deliberately |
| `prior_quotes/` | Completed proposals, for Templated Mode (FR-11) | Phase 6 |

## active_project.json

Created at **Phase 1 — File setup**, which is the JSON stand-in for CBC's Excel job
workbook. Updated at every phase gate: `phase_completed`, extracted schedules, unresolved
RFIs, pending vendor RFQs, and the final pricing summary.

## corrections.jsonl

One JSON object per line, appended whenever an estimator overrides a model, finish,
function, or supplier match:

```json
{
  "timestamp": "2026-08-07T13:30:00Z",
  "project": "Baldwin PA",
  "division": "08",
  "specified_callout": "Hager 3500 Storeroom",
  "copilot_initial_match": "Hager 3570 WTN",
  "estimator_override": "Hager 3470 WTN",
  "reason": "Specification requires Grade 1 for exterior service entrance"
}
```

Then feed it to `okf_learn_from_correction` so the pattern survives the session. Corrections
outrank automated catalog matches on later jobs — but the superseding product is still
verified against the price book before it is quoted.

## prior_quotes/

One file per completed bid, named `<project>.json`, holding the final proposal payload plus
`brand`, `architect` and `gc` so Templated Mode can find the closest match. CBC works two
ways (requirements 3.0): **templated** — open the nearest prior quote and trim it down —
and **one-off** — start blank. Phase 0 checks here for the templated path.

## The graph holds no prices

`knowledge_graph/graph.json` records *which* product, never *what it costs*. A price stored
here is a price nobody re-verified against a current price book, and it would reach a quote
line looking identical to a verified one. `validate()` rejects `list_price`, `net_cost`,
`price` and `cost` on any `CatalogProduct` node — run `okf_graph_status` to see the result.

The same applies to margins: only Wendy's programme is confirmed. McDonald's and Cava carry
`margin_status: PENDING_CBC_DATA` (NR-9) and resolve to the standard bands.
