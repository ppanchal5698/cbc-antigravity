/**
 * The Phase 6 audit, run by the gateway against the engine that owns it.
 *
 * The worker used to read `auditPassed` out of the model's own JSON and export a workbook
 * on the strength of it. The prompt asked for the engine's verdict "VERBATIM", but nothing
 * checked, so a model that wrote `true` — or a document that talked one into writing it —
 * got a finished-looking quote in CBC's customer-facing template. `format_cbc_proposal`
 * had zero call sites in this codebase.
 *
 * So the gateway calls it itself. The engine has no HTTP surface, and this follows the two
 * precedents already in the tree: `engine-ref.ts` and `mail-intake-gate.checkPlanSet` both
 * shell the workspace venv and parse one JSON line.
 *
 * The model's claim is still read — not as the verdict, but as a second opinion. When it
 * disagrees with the engine that is itself a finding: it means the model reported a pass
 * the engine did not give.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { WORKSPACE_ROOT } from './agy.ts';
import { toEngineAuditInput } from '../lib/xlsx/coerce.ts';

const run = promisify(execFile);

export type EngineAudit = {
  passed: boolean;
  failures: string[];
  /** Rate the ENGINE derived from the state, not one parsed out of a model-written label. */
  salesTaxRate: number;
  salesTaxAmount: number;
  state: string;
  openItems: string[];
};

function pythonPath(): string | null {
  const candidates = [
    process.env.WORKSPACE_PYTHON,
    join(WORKSPACE_ROOT, '.venv', 'bin', 'python'),
    join(WORKSPACE_ROOT, '.venv', 'Scripts', 'python.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Reads the payload on stdin rather than argv: a bid set's worth of lines is far past
 * every platform's argument limit, and the failure mode would be silent truncation.
 */
const SCRIPT = `
import json, sys
sys.path.insert(0, sys.argv[1])
from cbc_engine import engine

payload = json.load(sys.stdin)
result = engine.format_cbc_proposal(
    project_name=payload["projectName"],
    door_lines=payload["doorLines"],
    accessories_lines=payload["accessoryLines"],
    frp_lines=payload["frpLines"],
    alternates_lines=payload["alternates"] or None,
    state=payload["state"] or None,
)
json.dump({
    "passed": result["audit_passed"],
    "failures": [
        " ".join(part for part in (
            "[%s]" % (f.get("line") or f.get("block") or "?"),
            f.get("problem") or "",
            ("-> %s" % f["fix"]) if f.get("fix") else "",
        ) if part)
        for f in result["audit_failures"]
    ],
    "salesTaxRate": result["sales_tax_rate"],
    "salesTaxAmount": result["sales_tax_amount"],
    "state": result["state"],
    "openItems": result.get("open_items", []),
}, sys.stdout)
`;

/**
 * The engine's real verdict on a coerced estimate payload.
 *
 * Fails CLOSED, like every other gate in this system: a venv that is missing, a crash, or
 * unparseable output all return `passed: false`. An audit that cannot run has not passed.
 */
export async function auditWithEngine(payload: unknown): Promise<EngineAudit> {
  const notAudited = (detail: string): EngineAudit => ({
    passed: false,
    failures: [`the engine audit could not be run, so this package is not audited: ${detail}`],
    salesTaxRate: 0,
    salesTaxAmount: 0,
    state: '',
    openItems: [],
  });

  const python = pythonPath();
  if (!python) return notAudited(`no workspace virtualenv under ${WORKSPACE_ROOT}`);

  const enginePath = join(WORKSPACE_ROOT, '.agent', 'mcp', 'cbc-estimating-engine');
  const input = JSON.stringify(toEngineAuditInput(payload));

  try {
    const child = execFile(python, ['-c', SCRIPT, enginePath], {
      maxBuffer: 32_000_000,
      windowsHide: true,
    });
    child.stdin?.end(input);
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      let out = '';
      let err = '';
      child.stdout?.on('data', (chunk) => (out += chunk));
      child.stderr?.on('data', (chunk) => (err = (err + chunk).slice(-4000)));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve({ stdout: out }) : reject(new Error(err.trim() || `exit ${code}`)),
      );
    });
    return JSON.parse(stdout) as EngineAudit;
  } catch (err) {
    return notAudited(err instanceof Error ? err.message : String(err));
  }
}

/**
 * What the model *said* the engine returned. Kept only to compare against the real thing.
 *
 * Absence is not consent: a payload with no verdict is treated as not audited.
 */
export function claimedVerdict(raw: unknown): { claimedPass: boolean } {
  if (!raw || typeof raw !== 'object') return { claimedPass: false };
  const source = raw as Record<string, unknown>;
  return { claimedPass: (source.auditPassed ?? source.audit_passed) === true };
}
