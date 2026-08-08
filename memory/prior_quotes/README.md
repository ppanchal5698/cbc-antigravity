# prior_quotes/

Completed proposals, kept so Templated Mode has something to start from (FR-11,
requirements 3.0: *"start from the closest existing quote and modify"*).

One file per bid, `<project-slug>.json`:

```json
{
  "project_name": "Baldwin PA Revision 4",
  "completed": "2026-08-07",
  "brand": "wendys",
  "architect": "",
  "gc": "",
  "state": "PA",
  "mode": "one_off",
  "proposal": { "...": "the format_cbc_proposal payload" },
  "door_lines": [],
  "accessories_lines": [],
  "frp_lines": []
}
```

`brand` uses the same normalization as the knowledge graph (`wendys`, `mcdonalds`, `cava`,
`standard_commercial`) so Phase 0 can match on it directly.

Phase 6 writes the file, then calls `okf_learn_from_quote` with the same lines so the
patterns reinforce. The archive is the *starting draft*; the graph is the *pattern*. Both
are inputs to the next bid, and neither is a price source — costs are re-sourced every time,
because a price carried forward from an old quote is exactly the stale-data failure the
freshness rule exists to prevent.
