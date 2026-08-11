/**
 * Browser-driven Antigravity OAuth via a PTY broker.
 *
 * Print-mode auth waits only 30s — too short for a human pasting a code from
 * the UI. The broker drives `agy -i`, scrapes the Google URL, and injects the
 * code the gateway writes into its state directory.
 *
 * Tokens land in ~/.gemini/antigravity-cli/antigravity-oauth-token because the
 * broker (and runAgy) set fake SSH_* env vars for file-based storage.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

export const AGY_SSH_ENV = {
  SSH_CONNECTION: '203.0.113.1 50000 203.0.113.2 22',
  SSH_CLIENT: '203.0.113.1 50000 22',
  SSH_TTY: '/dev/pts/0',
} as const;

const BROKER_SCRIPT =
  process.env.AGY_AUTH_BROKER || join(process.cwd(), 'docker', 'agy_auth_broker.py');
const BROKER_DIR = process.env.AGY_BROKER_DIR || '/tmp/agybroker';
const TOKEN_PATH =
  process.env.AGY_OAUTH_TOKEN_PATH ||
  join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');

const URL_WAIT_MS = 90_000;
const CODE_SENT_WAIT_MS = 15_000;
const COMPLETE_WAIT_MS = 180_000;
const POLL_MS = 250;

export type AuthStatus = {
  signedIn: boolean;
  email: string | null;
  session: 'idle' | 'starting' | 'url-ready' | 'code-sent' | 'exited';
  url: string | null;
};

type Session = {
  child: ChildProcess;
  startedAt: number;
};

let session: Session | null = null;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readBrokerStatus(): Promise<string> {
  try {
    const raw = await readFile(join(BROKER_DIR, 'status'), 'utf8');
    return raw.trim() || 'idle';
  } catch {
    return session ? 'starting' : 'idle';
  }
}

async function readBrokerUrl(): Promise<string | null> {
  try {
    const raw = await readFile(join(BROKER_DIR, 'url'));
    const url = sanitizeOAuthUrl(raw.toString('utf8'));
    if (!url || !isCompleteOAuthUrl(url)) return null;
    return url;
  } catch {
    return null;
  }
}

/** Collapse whitespace and keep the first value for each query key. */
export function sanitizeOAuthUrl(raw: string): string {
  const cleaned = raw.replace(/\s+/g, '').trim();
  if (!cleaned) return '';
  try {
    const url = new URL(cleaned);
    const kept = new URLSearchParams();
    const seen = new Set<string>();
    for (const [key, value] of url.searchParams.entries()) {
      if (seen.has(key)) continue;
      seen.add(key);
      kept.append(key, value);
    }
    url.search = kept.toString();
    return url.toString();
  } catch {
    return cleaned;
  }
}

const REQUIRED_OAUTH_PARAMS = [
  'client_id',
  'response_type',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
] as const;

export function isCompleteOAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return REQUIRED_OAUTH_PARAMS.every((key) => Boolean(parsed.searchParams.get(key)));
  } catch {
    return false;
  }
}

async function readTokenEmail(): Promise<string | null> {
  try {
    const raw = await readFile(TOKEN_PATH, 'utf8');
    const parsed = JSON.parse(raw) as {
      email?: string;
      user?: { email?: string };
      token?: { email?: string };
    };
    return parsed.email || parsed.user?.email || parsed.token?.email || null;
  } catch {
    return null;
  }
}

export async function isSignedIn(): Promise<boolean> {
  return pathExists(TOKEN_PATH);
}

export async function authStatus(): Promise<AuthStatus> {
  const signedIn = await isSignedIn();
  const brokerStatus = await readBrokerStatus();
  let sessionState: AuthStatus['session'] = 'idle';
  if (session) {
    if (brokerStatus === 'url-ready') sessionState = 'url-ready';
    else if (brokerStatus === 'code-sent') sessionState = 'code-sent';
    else if (brokerStatus === 'exited') sessionState = 'exited';
    else sessionState = 'starting';
  } else if (brokerStatus === 'url-ready' || brokerStatus === 'code-sent') {
    sessionState = brokerStatus;
  }

  return {
    signedIn,
    email: signedIn ? await readTokenEmail() : null,
    session: sessionState,
    url: sessionState === 'url-ready' || sessionState === 'code-sent' ? await readBrokerUrl() : null,
  };
}

function killSession(): void {
  if (!session) return;
  const child = session.child;
  session = null;
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
  // Broker may leave a child agy; best-effort cleanup of the process group.
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Windows or already reaped
    }
  }
}

export async function cancelAuth(): Promise<{ ok: true }> {
  killSession();
  try {
    await rm(join(BROKER_DIR, 'code'), { force: true });
  } catch {
    // ignore
  }
  return { ok: true };
}

/** Drop the stored OAuth token and abort any in-flight sign-in broker. */
export async function logoutAuth(): Promise<{ ok: true; signedIn: false }> {
  await cancelAuth();
  await rm(TOKEN_PATH, { force: true });
  return { ok: true, signedIn: false };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    if (session && session.child.exitCode !== null) {
      const status = await readBrokerStatus();
      if (!(await predicate())) {
        throw new Error(`Antigravity sign-in ended early (${status || 'exited'}) while waiting for ${label}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * Start (or reuse) a broker session and return the Google OAuth URL once ready.
 */
export async function startAuth(): Promise<{ url: string; signedIn: boolean }> {
  if (await isSignedIn()) {
    return { url: '', signedIn: true };
  }

  // Reuse an in-flight session that already has a URL.
  if (session) {
    const existing = await readBrokerUrl();
    if (existing) return { url: existing, signedIn: false };
    // Still starting — wait on the same process.
  } else {
    await mkdir(BROKER_DIR, { recursive: true });
    for (const name of ['log', 'url', 'code', 'status'] as const) {
      await rm(join(BROKER_DIR, name), { force: true });
    }

    const child = spawn('python3', [BROKER_SCRIPT, 'reply with the single word OK'], {
      env: {
        ...process.env,
        ...AGY_SSH_ENV,
        AGY_BROKER_DIR: BROKER_DIR,
        AGY_BIN: process.env.AGY_BIN || 'agy',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
      windowsHide: true,
    });

    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('exit', () => {
      if (session?.child === child) session = null;
      if (stderr.trim()) {
        console.error('[agy-auth] broker exited:', stderr.trim().slice(0, 500));
      }
    });
    child.unref();
    session = { child, startedAt: Date.now() };
  }

  await waitFor(async () => Boolean(await readBrokerUrl()), URL_WAIT_MS, 'OAuth URL');
  const url = await readBrokerUrl();
  if (!url) throw new Error('Broker reported ready but no OAuth URL was captured');
  return { url, signedIn: false };
}

/**
 * Feed the authorization code to the live broker and wait for the token file.
 */
export async function completeAuth(code: string): Promise<{ signedIn: boolean; email: string | null }> {
  const trimmed = code.trim();
  if (!trimmed) throw new Error('Authorization code is required');
  if (!session && !(await readBrokerUrl())) {
    throw new Error('No sign-in session in progress. Start again to get a fresh OAuth URL.');
  }

  await mkdir(BROKER_DIR, { recursive: true });
  // Do not log the code.
  await writeFile(join(BROKER_DIR, 'code'), trimmed, { encoding: 'utf8', mode: 0o600 });

  // Broker must inject into the quiet paste prompt; fail fast if it never does.
  try {
    await waitFor(
      async () => (await isSignedIn()) || (await readBrokerStatus()) === 'code-sent',
      CODE_SENT_WAIT_MS,
      'broker to accept authorization code',
    );
  } catch (err) {
    const status = await readBrokerStatus();
    if (!(await isSignedIn()) && status !== 'code-sent') {
      throw new Error(
        err instanceof Error
          ? `${err.message} (broker status: ${status || 'unknown'}). Start sign-in again.`
          : String(err),
      );
    }
  }

  await waitFor(async () => isSignedIn(), COMPLETE_WAIT_MS, 'token file');
  killSession();
  return {
    signedIn: true,
    email: await readTokenEmail(),
  };
}
