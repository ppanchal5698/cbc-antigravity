/**
 * Vendor multipliers and margin bands, read out of the estimating engine.
 *
 * `cbc-estimating-rules.md` makes `cbc_engine.engine` the authority for these
 * numbers, so they are read from it rather than retyped in TypeScript. A
 * hand-copied table would drift, and drift here is a wrong multiplier in front
 * of an estimator. The engine has no HTTP surface, so this shells the workspace
 * venv once and caches the answer for the life of the process.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WORKSPACE_ROOT } from './agy.ts';

const run = promisify(execFile);

export type VendorTier = {
  vendor_name: string;
  multiplier: number | null;
  basis: string;
  effective_date: string;
  catalog_source?: string;
  notes: string;
  sourcing_type: string;
  manual_entry_prompt?: string;
  adders?: Record<string, Record<string, unknown>>;
};

export type EngineReference = {
  vendorTiers: Record<string, VendorTier>;
  marginBands: Record<string, { name: string; margin: number; divisor: number; note?: string }>;
  customerMargins: Record<string, Record<string, unknown>>;
  vendorAliases: Record<string, string>;
};

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
json.dump({
    "vendorTiers": engine.VENDOR_TIERS,
    "marginBands": engine.MARGIN_BANDS,
    "customerMargins": engine.CUSTOMER_SPECIAL_MARGINS,
    "vendorAliases": engine.VENDOR_ALIASES,
}, sys.stdout)
`;

let cached: Promise<EngineReference> | undefined;

export function engineReference(): Promise<EngineReference> {
  cached ??= (async () => {
    const python = pythonPath();
    if (!python) throw new Error(`No workspace virtualenv found under ${WORKSPACE_ROOT}`);
    const enginePath = join(WORKSPACE_ROOT, '.agent', 'mcp', 'cbc-estimating-engine');
    const { stdout } = await run(python, ['-c', SCRIPT, enginePath], {
      maxBuffer: 4_000_000,
      windowsHide: true,
    });
    return JSON.parse(stdout) as EngineReference;
  })().catch((err) => {
    // Do not cache a failure: the venv may still be building on first boot.
    cached = undefined;
    throw err;
  });
  return cached;
}
