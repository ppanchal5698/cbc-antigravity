/**
 * Is this line's cost still worth quoting? (NR-2 / FR-16, requirements 6.2.)
 *
 * `priceFreshness` renders on the review screen as `fresh` / `review` / `stale`, but
 * nothing ever computed it — the model asserted a value and the estimator saw it beside a
 * price, which is worse than an empty column: a reassurance nobody checked. `check_cost_freshness`
 * has existed in the engine, correct and tested, with no way to reach it from the UI.
 *
 * The date comes out of `cost_basis`, because that is where the sourcing citation already
 * lives — "p21_last_po (PO 88213, 2026-03-14)". Nothing new has to be captured for the
 * common case, and where no date is stated the answer is "unknown", never "fresh".
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_ROOT } from './workspace-db.ts';

export type Freshness = 'fresh' | 'review' | 'stale' | 'discard' | 'unknown';

export type FreshnessResult = {
  status: Freshness;
  usable: boolean;
  guidance: string;
  costDate: string | null;
  ageMonths: number | null;
};

/**
 * An ISO date out of a cost-basis citation, or null.
 *
 * Deliberately strict. A loose matcher would read the `2026` in "Hager PB#18 p42" or a
 * quote number as a date and age the line off a number that is not one — and an
 * incorrectly-aged cost is exactly the failure this is meant to catch, pointed the other
 * way. Only a full `YYYY-MM-DD` counts.
 */
export function costDateFrom(costBasis: string | null | undefined): string | null {
  const match = /\b(\d{4}-\d{2}-\d{2})\b/.exec(costBasis ?? '');
  if (!match) return null;
  const [iso] = match;
  // Reject calendar-impossible dates; `new Date` would silently roll 2026-02-31 over.
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(iso) ? null : iso;
}

function pythonPath(): string | null {
  const candidates = [
    process.env.WORKSPACE_PYTHON,
    join(WORKSPACE_ROOT, '.venv', 'bin', 'python'),
    join(WORKSPACE_ROOT, '.venv', 'Scripts', 'python.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const SCRIPT = `
import json, sys
sys.path.insert(0, sys.argv[1])
from cbc_engine import engine
print(json.dumps(engine.check_cost_freshness(sys.argv[2])))
`;

/**
 * The engine's verdict on a cost date. Never guesses: anything it cannot answer is
 * `unknown` and `usable: false`, which reads on the review screen as "go and check".
 */
export async function checkFreshness(costBasis: string | null): Promise<FreshnessResult> {
  const costDate = costDateFrom(costBasis);
  const unknown = (guidance: string): FreshnessResult => ({
    status: 'unknown',
    usable: false,
    guidance,
    costDate,
    ageMonths: null,
  });

  if (!costDate) {
    return unknown(
      'This line states no cost date, so its age cannot be checked. Record the P21 PO ' +
        'date or the price book effective date in the cost basis, or re-source the line.',
    );
  }

  const python = pythonPath();
  if (!python) return unknown('No workspace virtualenv, so the engine could not be asked.');

  const enginePath = join(WORKSPACE_ROOT, '.agent', 'mcp', 'cbc-estimating-engine');
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      const child = execFile(
        python,
        ['-c', SCRIPT, enginePath, costDate],
        { windowsHide: true },
        (err, out) => (err ? reject(err) : resolve({ stdout: out })),
      );
      child.stdin?.end();
    });
    const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
    const status = String(parsed.status ?? 'unknown') as Freshness;
    return {
      status,
      usable: parsed.usable === true,
      guidance: String(parsed.guidance ?? ''),
      costDate,
      ageMonths: typeof parsed.age_months === 'number' ? parsed.age_months : null,
    };
  } catch (err) {
    return unknown(
      `The engine could not be asked: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * What the review screen stores. The engine has four verdicts and the column has three,
 * so `discard` folds into `stale` — both mean "do not quote this" — and `unknown` clears
 * the column rather than inventing a level for it.
 */
export function toStoredFreshness(status: Freshness): 'fresh' | 'review' | 'stale' | null {
  if (status === 'fresh' || status === 'review' || status === 'stale') return status;
  if (status === 'discard') return 'stale';
  return null;
}
