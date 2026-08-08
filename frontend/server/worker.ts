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
    'When the estimate is complete, return the final answer as a single JSON object',
    'conforming to the supplied schema. Every line must carry its cost source and its',
    'plan/catalog citation - the audit gate rejects lines that do not. Do not invent a',
    'price, a model number, a multiplier or an adder value; leave the line unpriced and',
    'raise it in `rfis` instead.',
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
  void tick();
}
