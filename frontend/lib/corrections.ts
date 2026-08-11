/**
 * Estimator overrides, on their way to the knowledge graph.
 *
 * `okf-knowledge-graph-rules` and the Phase 5 gate both say an estimator override is
 * appended to `memory/corrections.jsonl` and then ingested with `okf_learn_from_correction`
 * — that is the whole continuous-learning loop, and FR-13. Nothing in the frontend did
 * either. The review screen wrote the estimator's edit to Postgres and stopped, so the
 * graph had learned nothing: `learning_cycles_completed` sat at 0 and the log held one
 * seeded `"project": "INIT"` row.
 *
 * The JSONL append is the durable half and happens inline. The graph ingestion is a
 * subprocess and is deliberately allowed to fail: an estimator's edit must not 500 because
 * Python was slow. A correction on disk can always be re-ingested; a correction lost
 * because the save failed is gone.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './workspace-db.ts';

export type Correction = {
  timestamp: string;
  project: string;
  division: string;
  specified_callout: string;
  copilot_initial_match: string;
  estimator_override: string;
  reason: string;
};

/** Division 10 tags are item marks (TA-1, B-262); Division 08 are opening numbers. */
function divisionOf(section: string): string {
  if (section === 'accessory') return '10';
  if (section === 'frp') return '06';
  return '08';
}

/**
 * The correction an edit represents, or null when it is not one.
 *
 * Only a change to what the line IS counts. A quantity edit is already captured by
 * `quantity_source` flipping to `estimator_confirmed`, and a price edit belongs in
 * `price_overrides.jsonl`, which `catalog-intelligence` owns — neither teaches the graph
 * which product an estimator prefers, and recording them here would mint patterns off
 * noise. Repetition is what earns confidence (`okf.learn_from_correction` starts at 0.6),
 * so a pattern built from typo fixes would quietly outrank a real one.
 */
export function correctionFrom(
  row: { tag: string; description: string; section: string },
  patch: { description?: string; substitution_notes?: string | null },
  project: string,
): Correction | null {
  const next = patch.description?.trim();
  if (!next) return null;
  const previous = row.description.trim();
  if (!previous || next === previous) return null;

  return {
    timestamp: new Date().toISOString(),
    project,
    division: divisionOf(row.section),
    // What the drawings called this line. The tag is the only stable handle the review
    // screen has: the description is precisely what is being corrected.
    specified_callout: row.tag || previous,
    copilot_initial_match: previous,
    estimator_override: next,
    reason: patch.substitution_notes?.trim() || 'estimator edit on the review screen',
  };
}

export function correctionsPath(): string {
  return join(WORKSPACE_ROOT, 'memory', 'corrections.jsonl');
}

/**
 * Appends one record. One JSON object per line, appended never rewritten.
 *
 * `path` is a parameter so a check can write somewhere disposable. `WORKSPACE_ROOT` is
 * bound at module load and ESM hoists imports, so there is no env var a test could set in
 * time — and a check that appended to the real `memory/corrections.jsonl` would teach the
 * graph from a fixture.
 */
export async function appendCorrection(
  correction: Correction,
  path: string = correctionsPath(),
): Promise<void> {
  await appendFile(path, `${JSON.stringify(correction)}\n`, 'utf8');
}

function pythonPath(): string | null {
  const candidates = [
    process.env.WORKSPACE_PYTHON,
    join(WORKSPACE_ROOT, '.venv', 'bin', 'python'),
    join(WORKSPACE_ROOT, '.venv', 'Scripts', 'python.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const INGEST = `
import json, sys
sys.path.insert(0, sys.argv[1])
from cbc_engine import okf
print(json.dumps(okf.graph(reload=True).learn_from_correction(json.load(sys.stdin))))
`;

/**
 * Ingest into the OKF graph. Never throws — the record is already on disk.
 *
 * `reload=True` because the graph is a process singleton and this process is long-lived;
 * the learn path takes the file lock itself, so a concurrent estimate cannot lose this.
 */
export async function ingestCorrection(correction: Correction): Promise<string | null> {
  const python = pythonPath();
  if (!python) return 'no workspace virtualenv; correction saved but not ingested';

  const enginePath = join(WORKSPACE_ROOT, '.agent', 'mcp', 'cbc-estimating-engine');
  try {
    const child = execFile(python, ['-c', INGEST, enginePath], { windowsHide: true });
    child.stdin?.end(JSON.stringify(correction));
    await new Promise<void>((resolve, reject) => {
      let err = '';
      child.stderr?.on('data', (chunk) => (err = (err + chunk).slice(-2000)));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`)),
      );
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Save, then learn. Returns the correction when one was recorded. */
export async function recordCorrection(
  row: { tag: string; description: string; section: string },
  patch: { description?: string; substitution_notes?: string | null },
  project: string,
): Promise<Correction | null> {
  const correction = correctionFrom(row, patch, project);
  if (!correction) return null;

  try {
    await appendCorrection(correction);
  } catch (err) {
    // Losing the durable half is worth a loud log; it is still not worth failing the edit.
    console.error('[corrections] could not append:', err instanceof Error ? err.message : err);
    return null;
  }

  const problem = await ingestCorrection(correction);
  if (problem) console.warn(`[corrections] saved but not ingested into the graph: ${problem}`);
  return correction;
}
