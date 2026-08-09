/**
 * Document workflow worker.
 *
 * Claims `pending` rows with FOR UPDATE SKIP LOCKED, so running more than one
 * replica of the agent service needs no coordination beyond Postgres.
 */
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgy, WORKSPACE_ROOT } from './agy.ts';
import { getRunBuffer, toFrames } from './events.ts';
import { query } from './db.ts';
import { buildQuotationWorkbook } from '../lib/xlsx/quotation.ts';
import { coerceQuotation, extractJson } from '../lib/xlsx/coerce.ts';
import { persistQuotationDraft } from '../lib/quote-draft.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, '..', 'lib', 'xlsx', 'schema.json');

const POLL_MS = Number(process.env.WORKER_POLL_MS || 2000);
const MAX_CONCURRENT = Number(process.env.WORKER_CONCURRENCY || 2);

type ClaimedRun = {
  id: string;
  project_id: string;
  project_name: string;
  slug: string;
  folder_path: string;
  filename: string | null;
  file_path: string | null;
};

/**
 * The estimate prompt. Delegates to the workspace's own `/run-estimate`
 * workflow rather than restating CBC's process here - that markdown is the
 * authority and must not be forked into application code.
 */
function estimatePrompt(run: ClaimedRun): string {
  const target = run.file_path ? relative(WORKSPACE_ROOT, run.file_path).replace(/\\/g, '/') : '';
  return [
    `/run-estimate Bid set for project "${run.project_name}".`,
    target
      ? `The document to estimate is \`${target}\`. Scope Phase 0 intake to that file only.`
      : `Estimate every document under \`${relative(WORKSPACE_ROOT, run.folder_path).replace(/\\/g, '/')}\`.`,
    '',
    'When the estimate is complete, run estimate-quality-gate over the whole package.',
    'Reject specialist payloads that are missing required fields (verified_against_*,',
    'cost_source, citations) rather than filling the gaps yourself — leave those lines',
    'unpriced and raise them in `rfis` with [not stated], [not indexed] or [not carried].',
    '',
    'Return the final answer as a single JSON object conforming to the supplied schema.',
    'Every line must carry its cost source and its plan/catalog citation - the audit gate',
    'rejects lines that do not. Do not invent a price, a model number, a multiplier or an',
    'adder value. Do not replace the JSON with free-form proposal prose.',
  ].join('\n');
}

async function claimRun(): Promise<ClaimedRun | null> {
  const rows = await query<ClaimedRun>(
    `UPDATE workflow_runs r
        SET status = 'running', started_at = now()
      WHERE r.id = (
        SELECT id FROM workflow_runs
         WHERE status = 'pending'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
    RETURNING r.id,
              r.project_id,
              (SELECT name        FROM projects p WHERE p.id = r.project_id) AS project_name,
              (SELECT slug        FROM projects p WHERE p.id = r.project_id) AS slug,
              (SELECT folder_path FROM projects p WHERE p.id = r.project_id) AS folder_path,
              (SELECT filename    FROM files f    WHERE f.id = r.file_id)    AS filename,
              (SELECT path        FROM files f    WHERE f.id = r.file_id)    AS file_path`,
  );
  return rows[0] ?? null;
}

async function processRun(run: ClaimedRun): Promise<void> {
  const buffer = getRunBuffer(run.id);
  const state = { sawText: false };
  let response = '';
  let conversationId: string | null = null;

  try {
    for await (const raw of runAgy({
      prompt: estimatePrompt(run),
      cwd: WORKSPACE_ROOT,
      jsonSchemaPath: SCHEMA_PATH,
    })) {
      for (const frame of toFrames(raw, state)) {
        if (frame.kind === 'conversation') conversationId = frame.conversationId;
        if (frame.kind === 'done') response = frame.response;
        if (frame.kind === 'error') throw new Error(frame.message);
        buffer.push(frame);
      }
    }

    const quotation = coerceQuotation(extractJson(response), run.project_name);
    const outputPath = join(run.folder_path, `CBC_Material_Quotation_${run.slug}.xlsx`);
    await persistQuotationDraft(run.id, run.project_id, quotation);
    await buildQuotationWorkbook(quotation).xlsx.writeFile(outputPath);

    await query(
      `UPDATE workflow_runs
          SET status = 'completed', finished_at = now(), output_path = $1, conversation_id = $2
        WHERE id = $3`,
      [outputPath, conversationId, run.id],
    );
    buffer.push({ kind: 'status', event: { ts: new Date().toISOString(), type: 'done' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE workflow_runs
          SET status = 'failed', finished_at = now(), error = $1, conversation_id = $2
        WHERE id = $3`,
      [message, conversationId, run.id],
    ).catch(() => {});
    if (!buffer.finished) buffer.push({ kind: 'error', message });
    console.error(`[worker] run ${run.id} failed:`, message);
  }
}

/** `30m` / `90s` / `2h` as milliseconds. Anything unparseable falls back to 30 minutes. */
function durationMs(value: string): number {
  const match = /^(\d+)\s*([smh])?$/i.exec(value.trim());
  if (!match) return 30 * 60_000;
  const scale = { s: 1_000, m: 60_000, h: 3_600_000 }[match[2]?.toLowerCase() ?? 'm']!;
  return Number(match[1]) * scale;
}

/**
 * Fails runs left `running` by a gateway that went away.
 *
 * `claimRun` only ever looks at `pending`, and nothing else resets the status, so a
 * gateway restart mid-estimate left the row `running` forever - the agy child died with
 * the process and the browser sat on a feed that never produced another frame.
 *
 * The age guard is what makes this safe to run with more than one replica: a run a
 * sibling is still working on is younger than agy's own `--print-timeout`, so only runs
 * that cannot still be alive are touched. They are failed rather than re-queued - an
 * estimate is a 30-minute paid run, and restarting one silently is not the gateway's
 * decision to make.
 */
async function failOrphanedRuns(): Promise<void> {
  const staleMs = durationMs(process.env.AGY_TIMEOUT || '30m') + 5 * 60_000;
  try {
    const rows = await query<{ id: string }>(
      `UPDATE workflow_runs
          SET status = 'failed', finished_at = now(),
              error = 'The agent service restarted while this estimate was running. Re-run it.'
        WHERE status = 'running'
          AND started_at < now() - ($1 || ' milliseconds')::interval
        RETURNING id`,
      [String(staleMs)],
    );
    if (rows.length) {
      console.warn(`[worker] failed ${rows.length} orphaned run(s):`, rows.map((r) => r.id).join(', '));
    }
  } catch (err) {
    console.error('[worker] orphan sweep failed:', err instanceof Error ? err.message : err);
  }
}

let running = 0;
let timer: NodeJS.Timeout | undefined;

async function tick(): Promise<void> {
  while (running < MAX_CONCURRENT) {
    let run: ClaimedRun | null;
    try {
      run = await claimRun();
    } catch (err) {
      console.error('[worker] claim failed:', err instanceof Error ? err.message : err);
      return;
    }
    if (!run) return;
    running += 1;
    void processRun(run).finally(() => {
      running -= 1;
    });
  }
}

/**
 * ponytail: polls every WORKER_POLL_MS. Switch to LISTEN/NOTIFY on the insert
 * if a two-second pickup delay ever matters.
 */
export function startWorker(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), POLL_MS);
  timer.unref();
  void failOrphanedRuns().then(tick);
}
