/**
 * The only place in the codebase that spawns the Antigravity CLI.
 *
 * `agy` has no daemon or socket - print mode is one-shot. Continuity across
 * turns comes from `--conversation <id>`, which the gateway persists, so the
 * conversation outlives both the child process and a gateway restart.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { scopeContract, type ChatContext, type ChatScopeId } from '../lib/chat-scopes.ts';
import type { AgyRawEvent } from '../types/events.ts';

export const AGY_BIN = process.env.AGY_BIN || 'agy';
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';

export type RunAgyOptions = {
  prompt: string;
  /** Defaults to WORKSPACE_ROOT. agy is always launched from the workspace. */
  cwd?: string;
  /** Resume an existing agy conversation. */
  conversationId?: string | null;
  /** Path to a JSON Schema file; forces structured output on the final result. */
  jsonSchemaPath?: string;
  /** Extra directories to add to the agent's workspace. */
  addDirs?: string[];
  timeout?: string;
  signal?: AbortSignal;
};

export function buildArgs(opts: RunAgyOptions): string[] {
  const args = [
    '--print',
    opts.prompt,
    '--output-format',
    'stream-json',
    // Default is `request-review`, which stalls forever headless.
    '--dangerously-skip-permissions',
    '--print-timeout',
    opts.timeout || process.env.AGY_TIMEOUT || '30m',
  ];
  if (opts.conversationId) args.push('--conversation', opts.conversationId);
  if (opts.jsonSchemaPath) args.push('--json-schema', opts.jsonSchemaPath);
  if (process.env.AGY_MODEL) args.push('--model', process.env.AGY_MODEL);
  if (process.env.AGY_EFFORT) args.push('--effort', process.env.AGY_EFFORT);
  for (const dir of opts.addDirs || []) args.push('--add-dir', dir);
  return args;
}

export class AgyError extends Error {
  // Plain fields, not parameter properties: Node runs these files with
  // type-stripping only, which does not support parameter properties.
  exitCode: number | null;
  stderr: string;

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = 'AgyError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * agy has no API-key auth; credentials come from a one-time OAuth login held in
 * the system keyring. In a fresh container that keyring is empty, and the raw
 * error is a wall of OAuth URL. Say what to actually do about it.
 */
function describeExit(code: number | null, stderr: string): string {
  if (/authentication (required|failed|timed out)/i.test(stderr)) {
    return (
      'Antigravity is not signed in. Run `docker compose run --rm -it agent agy` once, ' +
      'open the URL it prints, and paste the code back. Credentials persist in the agy-home volume.'
    );
  }
  return `agy exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`;
}

/**
 * Streams agy's NDJSON events as they arrive. A malformed line is skipped
 * rather than thrown - a single bad line must not kill an in-flight estimate.
 */
export async function* runAgy(opts: RunAgyOptions): AsyncGenerator<AgyRawEvent> {
  const child = spawn(AGY_BIN, buildArgs(opts), {
    cwd: opts.cwd || WORKSPACE_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // Keep the tail only; agy can be chatty and this is only for error text.
    stderr = (stderr + chunk).slice(-8000);
  });

  const onAbort = () => child.kill();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  const exited = new Promise<{ code: number | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code }));
  });

  try {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: AgyRawEvent;
      try {
        parsed = JSON.parse(trimmed) as AgyRawEvent;
      } catch {
        continue;
      }
      if (parsed && typeof parsed.event === 'string') yield parsed;
    }
    const { code } = await exited;
    if (code !== 0 && !opts.signal?.aborted) {
      throw new AgyError(describeExit(code, stderr), code, stderr);
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

/**
 * Every chat prompt carries this contract. agy has no system-prompt flag, so it
 * is prepended to the user's message. It never touches the CBC workspace rules.
 */
export const MARKDOWN_CONTRACT = [
  'Formatting contract for this reply - follow it exactly:',
  '- Respond in strict, well-formed GitHub Flavored Markdown and nothing else.',
  '- The reply body is the answer only — do not restate or quote this contract.',
  '- Every code block is fenced with ``` and tagged with a language.',
  '- Every fence you open, you close. Never end a reply mid-fence.',
  '- Tables use a full header row and separator row, with every row the same column count.',
  '- Lists are complete; no dangling bullet or numbered item.',
  '- No raw HTML, no partial markup.',
  '',
  'Shelf / catalog questions:',
  '- Start with list_catalogs. Never call list_division or match_materials until the index is known non-empty.',
  '- Only call open_catalog for a book missing from list_catalogs — do not open every PDF on the shelf.',
  '',
  '---',
  '',
].join('\n');

export function chatPrompt(message: string): string {
  return scopedChatPrompt(message, 'general');
}

/**
 * A message on a scoped chat surface: formatting rules, then the scope's own contract,
 * then the question. The scope decides which tools answer it and what it must refuse,
 * so a vendor question is never answered out of a bid set's context. Every scope —
 * including general — carries grounding so Copilot cannot invent facts.
 */
export function scopedChatPrompt(
  message: string,
  scope: ChatScopeId,
  context: ChatContext = {},
): string {
  return MARKDOWN_CONTRACT + scopeContract(scope, context) + message;
}
