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
  scope           text NOT NULL DEFAULT 'general',
  subject_key     text NOT NULL DEFAULT '',
  title           text,
  preview         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Additive upgrades for DBs that already had the narrower chat_sessions table.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'general';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS subject_key text NOT NULL DEFAULT '';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS preview text;

CREATE INDEX IF NOT EXISTS chat_sessions_surface_idx
  ON chat_sessions(scope, subject_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_session_idx
  ON chat_messages(session_id, created_at);

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
  -- Where the quantity and the size were READ, not what they are. A number with no
  -- provenance is a guess, and a guess is what put three invented grab-bar sizes at qty 1
  -- each into a quote whose schedule stated neither.
  quantity_source     text,
  size_source         text,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- schema.sql is replayed wholesale on every gateway start, and CREATE TABLE IF NOT EXISTS
-- will not add a column to a table that already exists. New columns need their own ALTER.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS quantity_source text;
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS size_source text;

CREATE INDEX IF NOT EXISTS quote_lines_draft_idx ON quote_lines(draft_id, section, sort_order);

-- Every message the poller has seen, and what was decided about it.
--
-- Two jobs in one table. The primary key is the RFC 5322 Message-ID, which makes it the
-- idempotency claim: a replica that cannot insert the row is not the one processing that
-- message, so `--scale agent=3` does not estimate the same email three times, and a crash
-- between writing the file and flagging the mail read replays exactly once.
--
-- It is also the audit trail. A refusal writes a row too - an inbox that silently drops
-- mail is indistinguishable from one that is broken.
CREATE TABLE IF NOT EXISTS email_intake (
  message_id  text PRIMARY KEY,
  sender      text NOT NULL,
  subject     text,
  received_at timestamptz,
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  outcome     text NOT NULL
              CHECK (outcome IN ('claimed', 'accepted', 'rejected_sender', 'rejected_auth',
                                 'rejected_file', 'rejected_quota', 'error')),
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The per-sender daily quota counts accepted rows for one address.
CREATE INDEX IF NOT EXISTS email_intake_sender_idx ON email_intake(sender, created_at DESC);

-- How far through a mailbox the poller has read.
--
-- The first version tracked progress by flagging messages \Seen, which works on a mailbox
-- that exists only for this - and quietly marks a person's real mail as read anywhere
-- else. IMAP UIDs ascend monotonically within a mailbox, so a high-water mark gives the
-- same "don't look at it twice" guarantee while never writing to the mailbox at all.
--
-- uid_validity is the reset signal: the server changes it when UIDs are renumbered, and
-- the old high-water mark means nothing afterwards.
CREATE TABLE IF NOT EXISTS mail_cursor (
  mailbox      text PRIMARY KEY,
  uid_validity bigint NOT NULL,
  last_uid     bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
