---
name: okf-knowledge-graph-rules
description: How to query and update the OKF knowledge graph in memory/knowledge_graph. It holds learned estimating patterns only - never prices.
trigger: always_on
---

# OKF knowledge graph

`memory/knowledge_graph/graph.json` is the workspace's institutional memory: patterns
learned from completed bids and estimator corrections. Reach it through the
`cbc-estimating-engine` tools `okf_query`, `okf_learn_from_quote`,
`okf_learn_from_correction` — never by reading or writing the JSON directly.

## What it holds, and what it must never hold

Classes: `BrandAccount`, `HardwareSetTemplate`, `CatalogProduct`, `WallTypeMapping`,
`VendorEquivalence`, `EstimatorCorrectionPattern`, `UncarriedDivisionPattern`.

**The graph carries no prices.** `CatalogProduct` nodes hold identity — vendor, model,
category, finish, pricing basis — so the graph can say *which* product, never *for how
much*. Every price comes from `catalog-intelligence` at the moment of quoting, because a
price in the graph is a price nobody re-verified against a current price book. If a graph
node ever appears to carry a cost, treat it as stale and look the product up.

The same applies to margins: only Wendy's programme margins are confirmed (NR-9). Other
brand nodes carry `PENDING_CBC_DATA` and must fall back to the standard bands.

## Query order

1. **Graph first**, for the cheap resolution: a `BrandAccount` template for this customer, a
   `WallTypeMapping` for a partition description, a `VendorEquivalence` or
   `EstimatorCorrectionPattern` for a specified manufacturer.
2. **Then verify against the shelf** — `lookup_product` / `verify_facts` on
   `catalog-intelligence`. A graph hit is a hypothesis; the catalog is the fact.
3. **Then the wholesaler path** for Allegion and other non-direct lines
   (`MANUAL_PRICE_ENTRY`).
4. **Then declare the gap** — `[not carried on shelf — outside RFQ required]`. Never fill it.

Confidence bands: ≥ 0.90 suggest with a citation to the graph rule · 0.70–0.89 offer as a
learned alternate needing sign-off · < 0.70 ignore and do the full catalog lookup.

## Learning

**On a completed proposal**, call `okf_learn_from_quote` with the finished lines and the
brand. It reinforces the brand → hardware-set and wall-type → throat edges actually used.

**On an estimator override**, append the record to `memory/corrections.jsonl`, then call
`okf_learn_from_correction`. It creates an `EstimatorCorrectionPattern` node and a
`SUPERSEDES` edge to the product it replaces; when the override is a genuine model
substitution it also records `SUBSTITUTED_BY`. A pattern starts below full confidence and
earns weight by being applied again — one estimator override is evidence, not law.

Estimator corrections outrank raw catalog defaults on later jobs, but they never suppress
the verification step: a superseding pattern still has its product confirmed against the
price book before it is quoted.
