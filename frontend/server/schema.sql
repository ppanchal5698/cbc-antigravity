-- Applied on gateway boot. Idempotent; no migration framework by design.
-- gen_random_uuid() is core in PostgreSQL 13+, so no extension is required.

CREATE TABLE IF NOT EXISTS projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  slug        text NOT NULL UNIQUE,
  folder_path text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  path        text NOT NULL,
  size_bytes  bigint NOT NULL,
  mime        text,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_project_idx ON files(project_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id         uuid REFERENCES files(id) ON DELETE SET NULL,
  conversation_id text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at      timestamptz,
  finished_at     timestamptz,
  error           text,
  output_path     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Partial index: the worker's claim query only ever looks for pending rows.
CREATE INDEX IF NOT EXISTS workflow_runs_pending_idx
  ON workflow_runs(created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS workflow_runs_project_idx
  ON workflow_runs(project_id, created_at DESC);

-- agy conversation ids, so a chat survives a gateway restart.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
