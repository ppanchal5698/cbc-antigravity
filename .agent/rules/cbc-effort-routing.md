---
name: cbc-effort-routing
description: Cost discipline for estimating work - which passes are cheap, which are expensive, and how to avoid paying twice for the same sheet.
trigger: always_on
---

# Effort routing

Model selection in Antigravity belongs to the user, in the model picker. Nothing here
switches models. What this rule controls is **how much work a step is allowed to cost**, and
`route_model_for_task(task_type, vision_need, ...)` returns that judgement deterministically
so it does not have to be re-argued each time.

## Three effort tiers

| Tier | Work | Applies to |
|---|---|---|
| **Routine** | Tool call, structured output, no deliberation | Quote math, margin bands, multiplier lookups, finish translation, throat derivation, FRP arithmetic, single-sheet `read_schedule`, intake triage |
| **Deliberate** | Read several sources and reconcile them | `cross_reference` across sheets, spec vs schedule conflicts, fire-rated opening compliance, hardware set reconciliation, proposal assembly |
| **Visual** | Render and read pixels — the expensive one | Sheets with `vision_need: full` (no text layer) or `identity` (title block outlined), enlarged restroom elevations, counting accessories off a drawing |

## Rules

**Never deliberate over arithmetic.** Sale prices, extensions, margins, tax and FRP
quantities go through `cbc-estimating-engine`. Reasoning about a division problem is both
slower and less accurate than calling the tool.

**Extract before you look.** Text extraction is exact, instant and free; vision is slow and
approximate. Spend a visual pass only where `vision_need` says the text is genuinely absent.
`plan_overview` gives the exact page list.

**Never pay twice for a sheet.** After reading tiles, call `record_vision_reading`
immediately — per tile, as you go, not batched at the end. Once recorded the sheet is
searchable and every later question about it drops back to a routine `read_schedule` /
`search_sheets`.

**Never render a whole sheet.** A 36x24in sheet downsampled whole puts 9pt notes at ~5px and
you will hallucinate from it. `render_sheet` tiles to 3x2 so the same text lands at ~16px.
Still too small — raise `cols`/`rows`, **not `dpi`**; raising DPI on one big tile is undone
by the resize. Use `region` to zoom a detail you have already located.

**Batch verification.** Collect every claim for a source and make one `verify_facts` call per
document. Never loop single-claim calls.
