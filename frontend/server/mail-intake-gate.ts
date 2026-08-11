/**
 * What is allowed to start an estimate by email.
 *
 * An inbox is reachable by anyone who learns the address, and accepting a message here
 * ends in `agy` spawning with `--dangerously-skip-permissions`, read-write on the whole
 * workspace, holding the gateway's environment, for up to thirty minutes. That is the
 * entire reason this file exists: the decision has to be made in code, before the run row
 * is inserted, exactly as `gatekeeper.ts` does for the chat channel.
 *
 * Every check fails CLOSED. A missing allowlist accepts nothing; an unreadable header is
 * a rejection; a validator that throws is a rejection. The failure mode is "no estimate
 * ran", never "anyone may run estimates".
 *
 * NOTE ON THE MESSAGE BODY: the body never reaches the agent, and must not. Prose written
 * by a stranger reaching a prompt that spawns a skip-permissions agent is remote code
 * execution with extra steps.
 *
 * The SUBJECT is a different matter, and this comment used to overstate it. It becomes the
 * project name (`projectNameFromSubject`), and the project name IS interpolated into the
 * estimate prompt in `worker.ts`. Control characters are stripped so it cannot forge extra
 * lines, and it is capped at 100 characters, and the sender is allowlisted with SPF and
 * DKIM both passing - but it is attacker-influenced text inside a prompt, so the worker
 * fences it in a `<project-name>` block and tells the agent it is data. If you add another
 * consumer of the project name, fence it there too.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '../lib/db.ts';

const run = promisify(execFile);

export type IntakeRejection =
  | 'rejected_sender'
  | 'rejected_auth'
  | 'rejected_file'
  | 'rejected_quota';

export type GateResult =
  | { ok: true }
  | { ok: false; outcome: IntakeRejection; detail: string };

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);
export const MAX_ATTACHMENT_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_PER_SENDER_PER_DAY = Number(process.env.INTAKE_MAX_PER_SENDER_PER_DAY || 20);
const MAX_PENDING_RUNS = Number(process.env.INTAKE_MAX_PENDING_RUNS || 25);
const PLAN_CHECK_TIMEOUT_MS = Number(process.env.INTAKE_PLAN_CHECK_TIMEOUT_MS || 120_000);
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';

/**
 * `Parth Panchal <A.User@Example.com>` and `a.user@example.com` are the same person.
 * Returns the bare address, lowercased, or '' when nothing address-shaped is present.
 */
export function parseAddress(from: string | null | undefined): string {
  if (!from) return '';
  const angled = /<([^>]+)>/.exec(from);
  const raw = (angled ? angled[1] : from).trim();
  // One address only: a From carrying a list is not something to guess about.
  if (/[,;]/.test(raw)) return '';
  const match = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.exec(raw);
  return match ? raw.toLowerCase() : '';
}

/** The configured allowlist. Empty when unset - which means "accept nothing". */
export function allowedSenders(): Set<string> {
  const raw = process.env.INTAKE_ALLOWED_SENDERS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => parseAddress(s))
      .filter(Boolean),
  );
}

export function checkSender(from: string | null | undefined): GateResult {
  const allow = allowedSenders();
  if (allow.size === 0) {
    return {
      ok: false,
      outcome: 'rejected_sender',
      detail:
        'INTAKE_ALLOWED_SENDERS is unset or empty, so no sender is authorised. This is ' +
        'deliberate: an unconfigured allowlist must accept nothing, not everything.',
    };
  }
  const address = parseAddress(from);
  if (!address) {
    return { ok: false, outcome: 'rejected_sender', detail: `unparseable From: ${from ?? ''}` };
  }
  if (!allow.has(address)) {
    return { ok: false, outcome: 'rejected_sender', detail: `sender not allowlisted: ${address}` };
  }
  return { ok: true };
}

/**
 * A `From` header is free text - anyone can write anyone's address in it. The receiving
 * server's own verdict is what makes the allowlist mean something, so require Gmail to
 * have seen both SPF and DKIM pass.
 */
export function checkAuthentication(authResults: string | string[] | null | undefined): GateResult {
  const joined = Array.isArray(authResults) ? authResults.join('\n') : (authResults ?? '');
  if (!joined.trim()) {
    return {
      ok: false,
      outcome: 'rejected_auth',
      detail: 'no Authentication-Results header; sender identity is unverified',
    };
  }
  const spf = /\bspf=(\w+)/i.exec(joined)?.[1]?.toLowerCase();
  const dkim = /\bdkim=(\w+)/i.exec(joined)?.[1]?.toLowerCase();
  if (spf !== 'pass' || dkim !== 'pass') {
    return {
      ok: false,
      outcome: 'rejected_auth',
      detail: `SPF/DKIM did not both pass (spf=${spf ?? 'absent'}, dkim=${dkim ?? 'absent'})`,
    };
  }
  return { ok: true };
}

/**
 * A PDF by content, not by filename.
 *
 * The upload allowlist is `endsWith` on the name (`lib/uploads.ts`), so a `.docx` renamed
 * `.pdf` passes it. Bytes do not lie: every PDF begins `%PDF-`.
 */
export function checkAttachment(filename: string, bytes: Uint8Array): GateResult {
  if (!filename.toLowerCase().endsWith('.pdf')) {
    return { ok: false, outcome: 'rejected_file', detail: `not a .pdf: ${filename}` };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, outcome: 'rejected_file', detail: `empty attachment: ${filename}` };
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      outcome: 'rejected_file',
      detail: `${filename} exceeds the ${MAX_UPLOAD_MB} MB limit`,
    };
  }
  const header = Buffer.from(bytes.subarray(0, 5)).toString('latin1');
  if (header !== '%PDF-') {
    return {
      ok: false,
      outcome: 'rejected_file',
      detail: `${filename} is named .pdf but does not begin with %PDF-`,
    };
  }
  return { ok: true };
}

/**
 * Backpressure. There is none anywhere else in this system - an upload loop can queue
 * unbounded thirty-minute runs - and an inbox is the one input a stranger can reach.
 */
export async function checkQuota(sender: string): Promise<GateResult> {
  const pending = await query<{ n: string }>(
    `SELECT count(*) AS n FROM workflow_runs WHERE status IN ('pending','running')`,
  );
  if (Number(pending[0]?.n ?? 0) >= MAX_PENDING_RUNS) {
    return {
      ok: false,
      outcome: 'rejected_quota',
      detail: `${pending[0]?.n} runs already queued (cap ${MAX_PENDING_RUNS}); try again later`,
    };
  }
  const today = await query<{ n: string }>(
    `SELECT count(*) AS n FROM email_intake
      WHERE sender = $1 AND outcome = 'accepted' AND created_at > now() - interval '1 day'`,
    [sender],
  );
  if (Number(today[0]?.n ?? 0) >= MAX_PER_SENDER_PER_DAY) {
    return {
      ok: false,
      outcome: 'rejected_quota',
      detail: `${sender} has queued ${today[0]?.n} estimates today (cap ${MAX_PER_SENDER_PER_DAY})`,
    };
  }
  return { ok: true };
}

/**
 * Does this PDF actually look like a plan set?
 *
 * A valid PDF that is an invoice or a scanned letter costs a full thirty-minute run before
 * the audit gate rejects whatever comes out. The workspace already contains an indexer
 * that answers the question in seconds, so ask it first. A non-zero exit, a timeout or an
 * unreadable answer is a rejection - the check is here to save a run, and failing open
 * would defeat it.
 */
export async function checkPlanSet(pdfPath: string): Promise<GateResult & { sheets?: number }> {
  const python =
    process.env.INTAKE_PYTHON || `${WORKSPACE_ROOT}/.venv/bin/python`;
  const script = [
    'import json,sys',
    'sys.path.insert(0, sys.argv[1])',
    'from bpi import index as ix',
    'con = ix.connect()',
    'doc_id, _ = ix.index_doc(sys.argv[2], con=con)',
    'n = con.execute("SELECT count(*) FROM sheets WHERE doc_id=?", (doc_id,)).fetchone()[0]',
    'print(json.dumps({"sheets": n}))',
  ].join('\n');

  try {
    const { stdout } = await run(
      python,
      ['-c', script, `${WORKSPACE_ROOT}/.agent/mcp/building-plan-intelligence`, pdfPath],
      { timeout: PLAN_CHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    const line = stdout.trim().split('\n').pop() ?? '';
    const sheets = Number((JSON.parse(line) as { sheets?: unknown }).sheets);
    if (!Number.isFinite(sheets) || sheets <= 0) {
      return {
        ok: false,
        outcome: 'rejected_file',
        detail: 'the PDF parsed but contains no readable sheets, so it is not a plan set',
      };
    }
    return { ok: true, sheets };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      outcome: 'rejected_file',
      detail: `plan-set check failed, refusing rather than spending a run: ${detail.slice(0, 300)}`,
    };
  }
}

/**
 * The header-only half of the gate, in cheapest-first order. Attachment and plan-set
 * checks need bytes on disk and run separately, per attachment.
 */
export async function screenMessage(msg: {
  from: string | null | undefined;
  authenticationResults: string | string[] | null | undefined;
}): Promise<GateResult> {
  const sender = checkSender(msg.from);
  if (!sender.ok) return sender;

  const auth = checkAuthentication(msg.authenticationResults);
  if (!auth.ok) return auth;

  return checkQuota(parseAddress(msg.from));
}
