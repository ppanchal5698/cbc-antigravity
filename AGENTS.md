# CBC Commercial Estimating & Pricing Copilot

Workspace for **Construction Building Components (CBC)**, the national-accounts estimating
division of The Hamilton Parker Company. It turns a commercial bid set into a draft material
quote: read the drawings, source every line from a real price book, compute the pricing
deterministically, and hand the estimator something they can check.

The domain boundary, the estimating rules and the phase gates are always-on rules in
[`.agent/rules/`](.agent/rules/) — this file is the map, not the rulebook.

---

## The three servers

| Plugin | MCP server | Answers |
|---|---|---|
| [building-plan](.agent/plugins/building-plan/) | `building-plan-intelligence` | What the drawings **require** — schedules, partitions, dimensions, tags |
| [catalog](.agent/plugins/catalog/) | `catalog-intelligence` | Which **vendor** supplies it, and at what catalog price |
| [estimating](.agent/plugins/estimating/) | `cbc-estimating-engine` | The **math** — quote formulas, multiplier tiers, margin bands, proposal assembly, and the OKF knowledge graph |

Source lives in [`.agent/mcp/`](.agent/mcp/), registered in
[`.agent/mcp_config.json`](.agent/mcp_config.json). All three run from the workspace `.venv`.

**The engine holds no prices.** Prices come from `catalog-intelligence`, from P21, or from a
vendor quote — never from the engine's reference data and never from the knowledge graph.

## Where things live

```
plans/                 bid sets (PDF)
catalogs/              vendor price books, one folder per vendor - the folder IS the vendor
memory/                job record, corrections log, prior quotes, OKF graph
sandbox/               agent-written Python, isolated
.agent/rules/          always-on rules
.agent/plugins/        plugin.json + skills/ + agents/
.agent/mcp/            the three servers
docs/requirements.md   CBC's confirmed requirements matrix - the authority for the process
```

---

## The process — CBC's own, Phase 0 to 6

0 **Intake** · 1 **File setup** · 2 **Spec scoping** · 3 **Drawing review & take-offs**
(3b FRP) · 4 **Pricing & build** (4b alternates & addenda) · 5 **Judgment, reuse & RFIs** ·
6 **Deliver**

Confirmed by the estimators on 14 Jul (`docs/requirements.md` § Process Flow). Gates and
guardrails: [`.agent/rules/cbc-phase-gates.md`](.agent/rules/cbc-phase-gates.md). Procedure:
[`cbc-master-workflow`](.agent/plugins/estimating/skills/cbc-master-workflow/SKILL.md).

## Agents

Three delegable specialists, each for one half of a takeoff:
[`door-hardware-estimator`](.agent/plugins/estimating/agents/door-hardware-estimator.md) (Div 08),
[`specialties-estimator`](.agent/plugins/estimating/agents/specialties-estimator.md) (Div 10 & 06),
[`pricing-calculator`](.agent/plugins/estimating/agents/pricing-calculator.md) (costing and quote math).

Governance is not an agent — phase gates, grounding and math invariants are always-on rules
binding the main thread, checked with
[`estimate-quality-gate`](.agent/plugins/estimating/skills/estimate-quality-gate/SKILL.md)
before anything is shown to a person.

## Skills

| Skill | Plugin | For |
|---|---|---|
| [`cbc-master-workflow`](.agent/plugins/estimating/skills/cbc-master-workflow/SKILL.md) | estimating | The end-to-end estimate, Phase 0 to 6 |
| [`estimate-quality-gate`](.agent/plugins/estimating/skills/estimate-quality-gate/SKILL.md) | estimating | The check before any draft is shown |
| [`door-hardware-schedule`](.agent/plugins/estimating/skills/door-hardware-schedule/SKILL.md) | estimating | Div 08 schedules, throats, hardware sets, finishes |
| [`specialties-takeoff`](.agent/plugins/estimating/skills/specialties-takeoff/SKILL.md) | estimating | Div 10 accessories and dryers, cross-shelf matching, gaps |
| [`frp-takeoff`](.agent/plugins/estimating/skills/frp-takeoff/SKILL.md) | estimating | Div 06 FRP panels, trims, adhesive |
| [`cbc-quote-pricing`](.agent/plugins/estimating/skills/cbc-quote-pricing/SKILL.md) | estimating | The four cost paths, multipliers, margins, tax |
| [`estimate-proposal-generator`](.agent/plugins/estimating/skills/estimate-proposal-generator/SKILL.md) | estimating | Phase 6 draft proposal |
| [`plan-set-intake`](.agent/plugins/building-plan/skills/plan-set-intake/SKILL.md) | building-plan | Index a new plan set, run the vision pass |
| [`plan-sheet-lookup`](.agent/plugins/building-plan/skills/plan-sheet-lookup/SKILL.md) | building-plan | Answer one question about an indexed set |
| [`vendor-catalog-intake`](.agent/plugins/catalog/skills/vendor-catalog-intake/SKILL.md) | catalog | Index the shelf, establish CSI coverage |
| [`division-takeoff`](.agent/plugins/catalog/skills/division-takeoff/SKILL.md) | catalog | Cross-server requirement-to-vendor takeoff |

---

## The vendor shelf

10 vendors, 17 PDFs indexed. `list_catalogs` is the live version of this;
[`catalogs/README.md`](catalogs/README.md) has the detail including each book's coverage.

| Need | Vendors | Basis |
|---|---|---|
| **10 28 00** washroom accessories | ASI, Bobrick (+Gamco), Bradley | ASI `0.375` list · Bobrick/Gamco `1.0` **net cost each** · Bradley `0.53` list |
| **10 28 13** hand dryers | ASI, World Dryer | World Dryer `0.339` list — the real book is `.xlsx` and **is** indexed; read `price_basis` on its rows |
| **08 71 00** door hardware | Hager | `0.29` list ('50 & 42' tier, ~75% of volume) |
| **08 71 00** thresholds, gasketing | Pemko/Markar, National Guard | both `0.45` list — NGP prices per foot by formula, `text_only` |
| **08 71 00** pulls, plates, protection | Rockwood | `0.55` list — `partial`, finish-matrix pricing needs `get_page` |
| **06 64 00** FRP panels & mouldings | NUDO | direct rows — `text_only`, needs `get_page` |
| **08 71 00** Allegion (Von Duprin, LCN, Schlage, Ives) | Banner Solutions, SecLock | **manual net entry** — `MANUAL_PRICE_ENTRY` |
| **10 21 13** partitions · **10 51 00** lockers · **10 44 00** extinguisher cabinets | nobody | `[not carried on shelf — outside RFQ required]` |

A `text_only` or `partial` catalog's silence is not evidence a vendor does not carry
something. Never quote a list price as a cost.

---

## OKF knowledge graph

[`memory/knowledge_graph/graph.json`](memory/knowledge_graph/graph.json) is the institutional
memory: brand programmes, hardware set templates, wall-to-throat mappings, approved
substitutions, and patterns learned from estimator corrections. Reached through
`okf_query`, `okf_hardware_set`, `okf_learn_from_quote`, `okf_learn_from_correction`,
`okf_graph_status`.

It records **which** product, never what it costs — a price stored there is a price nobody
re-verified, and `validate()` rejects one on sight. Same for margins: only Wendy's programme
is confirmed; McDonald's and Cava carry `PENDING_CBC_DATA` and fall back to the standard
bands. Rules: [`.agent/rules/okf-knowledge-graph-rules.md`](.agent/rules/okf-knowledge-graph-rules.md).

## Sandbox

Agent-written Python runs in [`sandbox/`](sandbox/) under the workspace `.venv`, with a write
guard that refuses writes resolving outside `sandbox/` or the OS temp directory, and a
`script_name` check that keeps the script itself inside `sandbox/scripts/`. Run via
`execute_sandbox_script` or `python sandbox/runner.py <script>`. It protects against
mistakes, not against hostile code.

## Open items

CBC has not confirmed these; the copilot raises them as RFIs rather than assuming an answer:
**fire rating** — where it lives on bids, which categories price on it (7.3) · **alternates
& addenda** reconciliation (4.1 / FR-14) · **FRP conversion constants** (Open Item 5) ·
**Hager adder values** for electrification, NRP and premium finishes (NR-7) ·
**special-customer margins** beyond Wendy's (NR-9).

## Tests

```bash
.venv/Scripts/python.exe -m pytest .agent/mcp -q
```
