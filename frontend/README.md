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

```bash
docker compose up -d
```

The UI is on <http://localhost:3000>.

**Sign in to Antigravity once.** `agy` has no API-key auth — credentials come
from an OAuth login cached in the agent container (file-based token under
`~/.gemini/`, in the `agy-home` volume).

In the UI, click **Needs sign-in** in the top bar. Open the Google URL it shows,
approve access, and paste the code back. Credentials survive restarts.
**Log out** next to **Signed in** clears the token from the agent volume.

CLI fallback (same OAuth dance in a terminal):

```bash
docker compose run --rm -it agent agy
```

Until this is done every run fails with *"Antigravity is not signed in"*.

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

### Exposure

Every published port binds to `127.0.0.1` by default, and the gateway requires a
shared secret the moment it does not. Both matter, because of what is behind
them:

- `POST :8787/chat` spawns `agy` with `--dangerously-skip-permissions`, holding
  the gateway's environment, read-write on the whole workspace, for up to
  `AGY_TIMEOUT`. `POST :8787/auth/logout` deletes the OAuth token.
- The UI has **no login**. Whoever reaches `:3000` can approve a draft quote,
  download a workbook, delete chat history and queue estimates.
- The domain gate in front of chat is a **scope classifier**, not an access
  control. It decides whether a message is CBC estimating work — not whether the
  sender is entitled to ask.

**The rule is: exposure requires a token.**

| `BIND_ADDR` | `GATEWAY_TOKEN` | Result |
|---|---|---|
| `127.0.0.1` (default) | unset | Runs. The OS is the boundary. |
| `127.0.0.1` | set | Runs, and the token is enforced on every route. |
| anything else | unset | **Refuses to start**, with the reason. |
| anything else | set | Runs, token enforced. |

The gateway fails at boot rather than serving, because a secret that defaults to
"off" fails open exactly when someone widens the bind — which is the moment it
starts mattering. The token is enforced on `/health` too: an open health
endpoint is a free confirmation that the port is a CBC gateway, and it reports
the workspace path and sign-in state with it.

`GATEWAY_TOKEN` is a shared secret between the web app and the gateway, not a
user login. It distinguishes *the Quote Desk* from *anything else that can reach
the port*. Per-user authentication and an audit trail of who approved which
quote are still open — that is NFR-4 (*"drawings, pricing and customer data
remain in an approved, access-controlled environment"*), which
`docs/requirements.md` records as still needing a named owner. If your
environment already fronts this with SSO, that proxy is the answer and this
token is belt-and-braces.

`POSTGRES_PASSWORD` is likewise required, with no default. It used to fall back
to `cbc`, which put a known password on a published port.

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

`node` does not read `.env`, so the gateway needs `DATABASE_URL` in its own
environment — and it must name the port compose actually publishes (`5433`, not
`5432`) and the password you set in `.env`:

```bash
DATABASE_URL="postgres://cbc:$POSTGRES_PASSWORD@localhost:5433/cbc" AGY_BIN="$LOCALAPPDATA/agy/bin/agy.exe" WORKSPACE_ROOT="$(cd .. && pwd)" npm run gateway
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
