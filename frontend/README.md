# CBC Estimating Copilot — web frontend

Chat and document-processing UI for the CBC commercial estimating workspace — **Quote Desk**:
a dense navy-anchored estimating workstation. It drives the **Antigravity CLI** (`agy`)
headlessly, streams the agent's real event feed to the browser, and turns a completed
estimate into the fixed-template `.xlsx` CBC already produces by hand.

Everything runs in Docker: workspace volume + backup, `agy`, the UI, the workers
and Postgres.

---

## First run

```bash
cp .env.example .env
```

```bash
docker compose build
```

**Sign in to Antigravity once.** `agy` has no API-key auth — credentials come
from an OAuth login cached in the container's keyring, which lives in the
`agy-home` volume and survives restarts.

```bash
docker compose run --rm -it agent agy
```

It prints an authorization URL; open it in a browser, sign in, and paste the
code back. Until this is done every run fails with *"Antigravity is not signed
in"*.

```bash
docker compose up -d
```

The UI is on <http://localhost:3000>.

First boot takes a few minutes: the agent container seeds `/workspace` from the
host CBC workspace (mounted read-only at `/seed`), builds a Linux virtualenv and
installs the three MCP servers. It is skipped on every boot after that.

---

## Services

| Service | Role |
|---|---|
| `db` | Postgres 18. `projects`, `files`, `workflow_runs`, `chat_sessions`, `quote_drafts`, `quote_lines`. |
| `agent` | The long-lived Antigravity connection: SSE gateway on `:8787` plus the document worker. `agy` is always launched with `cwd=/workspace`. |
| `web` | Next.js UI. Proxies chat and run events to `agent`; talks to Postgres directly. |
| `backup` | Periodic `tar.gz` snapshot of the workspace volume into `./backups`. |

The host CBC workspace is mounted **read-only**. `/workspace` is a named volume
seeded from it, so the container can rewrite `.agent/mcp_config.json` to Linux
paths without disturbing the Windows paths your Antigravity IDE still uses.

Scale the workers with `docker compose up -d --scale agent=3`; runs are claimed
with `FOR UPDATE SKIP LOCKED`, so replicas need no coordination.

---

## How it works

`agy` is one-shot print mode — there is no daemon to hold open. The gateway is
the persistent piece: it owns conversation state, resumes turns with
`--conversation <id>` (persisted in `chat_sessions`), and runs the worker in the
same process so a browser refresh cannot orphan an estimate.

Its `--output-format stream-json` NDJSON is the event channel. Each line is
timestamped as it is read and mapped to a `StatusEvent`
(`starting`, `tool_use`, `tool_result`, `tool_error`, `crafting_response`,
`finalizing`, `done`, `error`) in [`server/events.ts`](server/events.ts), then
multiplexed with the token stream over one SSE connection. Unrecognised step
types pass through rather than being dropped. Nothing in the feed is simulated.

Uploading a file into a project is the trigger — there is no run button. The
file lands in `plans/<slug>/`, a `workflow_runs` row is enqueued, and the worker
invokes the workspace's own `/run-estimate` workflow with
`--json-schema lib/xlsx/schema.json`.

Every output is a draft for estimator review. Nothing is sent to a customer.

### Quote Desk UI + FR-9 review

The app shell uses a left sidebar (Work / Reference) with blueprint-grid chrome
and a context-aware top bar. After an estimate completes, open **Review** on the
run (`/projects/<id>/runs/<runId>/review`) to accept, edit, reject, or add lines,
enter manual prices and substitution notes, then **Approve & export**. Approval
regenerates the fixed-template `.xlsx` from the accepted lines; download is
secondary until then.

---

## Running without Docker

Useful for working on the UI. Needs Postgres and a host `agy`.

```bash
docker compose up -d db
```

```bash
AGY_BIN="$LOCALAPPDATA/agy/bin/agy.exe" WORKSPACE_ROOT="$(cd .. && pwd)" npm run gateway
```

```bash
npm run dev
```

---

## Checks

```bash
npm run check && npm run lint && npm run typecheck && npm run build
```

- `check:events` replays real captured `agy` NDJSON through the mapper.
- `check:xlsx` locks the quotation template — headers, column widths, section
  order, live formulas — so structure can never drift between runs.
