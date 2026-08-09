# .agent/mcp/

The three MCP servers this workspace runs. **This is the single source of truth for their
source.**

| Directory | Module | Server name |
|---|---|---|
| `building-plan-intelligence/` | `bpi` | `building-plan-intelligence` |
| `catalog-intelligence/` | `catint` | `catalog-intelligence` |
| `cbc-estimating-engine/` | `cbc_engine` | `cbc-estimating-engine` |

All three run on `../../.venv` and are registered in
[`../mcp_config.json`](../mcp_config.json), which puts each server's directory on
`PYTHONPATH` — they are **not** editable-installed into the venv, so removing those
`PYTHONPATH` entries stops all three from importing.

## Superseded copies

Standalone clones exist outside this workspace at
`c:\Parth Panchal\mcp-servers\{building-plan-intelligence,catalog-intelligence,cbc-estimating-engine}`.
They predate the move into `.agent/mcp/` and the estimating-engine copy has already
diverged. They are **not** used by this workspace and are not maintained here. Edit the
copies in this directory; if the standalone repos are still wanted for another consumer,
sync them from here rather than the other way round.

`~/.gemini/config/mcp_config.json` also references the standalone copies with a system
Python and omits `cbc-estimating-engine` entirely. That config belongs to Gemini CLI, not
Antigravity, and does not describe this workspace.

## Index caches

`bpi` and `catint` each keep a sqlite/FTS5 index. `mcp_config.json` points both at
`.agent/cache/` inside the workspace (via `BPI_CACHE` / `CATINT_CACHE`) so the index travels
with the workspace instead of living in `~/.cache`. The cache is gitignored and rebuilds on
demand — deleting it costs one re-index, nothing more.
