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

-- FR-9: persistable quote draft. The .xlsx is an export of this, not the source of truth.
CREATE TABLE IF NOT EXISTS quote_drafts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL UNIQUE REFERENCES workflow_runs(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  header          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'approved')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quote_drafts_project_idx ON quote_drafts(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS quote_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id            uuid NOT NULL REFERENCES quote_drafts(id) ON DELETE CASCADE,
  section             text NOT NULL
                      CHECK (section IN ('door', 'accessory', 'frp', 'custom')),
  sort_order          int NOT NULL DEFAULT 0,
  tag                 text NOT NULL DEFAULT '',
  room                text NOT NULL DEFAULT '',
  description         text NOT NULL DEFAULT '',
  qty                 double precision NOT NULL DEFAULT 0,
  unit                text NOT NULL DEFAULT 'EA',
  unit_sale           double precision NOT NULL DEFAULT 0,
  cost_basis          text NOT NULL DEFAULT 'not_specified',
  citations           text NOT NULL DEFAULT '[not stated]',
  confidence          text CHECK (confidence IS NULL OR confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  acceptance          text NOT NULL DEFAULT 'pending'
                      CHECK (acceptance IN ('pending', 'accepted', 'rejected')),
  pricing_status      text NOT NULL DEFAULT 'priced'
                      CHECK (pricing_status IN ('priced', 'manual_entry_required', 'awaiting_vendor_rfq')),
  price_freshness     text CHECK (price_freshness IS NULL OR price_freshness IN ('fresh', 'review', 'stale')),
  substitution_notes  text,
  unit_cost           double precision,
  margin_rate         double precision,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quote_lines_draft_idx ON quote_lines(draft_id, section, sort_order);
