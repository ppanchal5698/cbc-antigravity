/**
 * The Antigravity gateway.
 *
 * Long-lived process that owns the connection to the Antigravity CLI. It is a
 * singleton service, never spawned per request: chat turns resume conversations
 * by id, and the document worker runs in the same process so a browser refresh
 * or a Next.js restart cannot orphan an in-flight estimate.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { runAgy, scopedChatPrompt, AgyError, WORKSPACE_ROOT } from './agy.ts';
import {
  authStatus,
  cancelAuth,
  completeAuth,
  isSignedIn,
  logoutAuth,
  startAuth,
} from './agy-auth.ts';
import { gate, REFUSAL_TEXT } from './gatekeeper.ts';
import {
  CHAT_SCOPES,
  sessionTitleFromMessage,
  subjectKey,
  type ChatContext,
  type ChatScopeId,
} from '../lib/chat-scopes.ts';
import { getRunBuffer, sseFrame, toFrames } from './events.ts';
import { engineReference } from './engine-ref.ts';
import { initDb, query } from './db.ts';
import { startMailIntake } from './mail-intake.ts';
import { startWorker } from './worker.ts';
import type { StreamFrame } from '../types/events.ts';

const PORT = Number(process.env.AGENT_PORT || 8787);

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Disables proxy buffering; without it the status feed arrives in one lump.
  'X-Accel-Buffering': 'no',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

type SessionRow = {
  id: string;
  conversation_id: string | null;
  scope: string;
  subject_key: string;
  title: string | null;
  preview: string | null;
};

/** Resolves the agy conversation id for a chat session, creating the row if new. */
async function resolveSession(
  sessionId: string | undefined,
  projectId: string | null,
  scope: ChatScopeId,
  subject: string,
): Promise<{ sessionId: string; conversationId: string | null; isNew: boolean }> {
  if (sessionId) {
    const rows = await query<SessionRow>(
      'SELECT id, conversation_id, scope, subject_key, title, preview FROM chat_sessions WHERE id = $1',
      [sessionId],
    );
    if (rows[0]) {
      return {
        sessionId: rows[0].id,
        conversationId: rows[0].conversation_id,
        isNew: false,
      };
    }
  }
  const rows = await query<{ id: string }>(
    `INSERT INTO chat_sessions (project_id, scope, subject_key)
     VALUES ($1, $2, $3) RETURNING id`,
    [projectId, scope, subject],
  );
  return { sessionId: rows[0].id, conversationId: null, isNew: true };
}

async function persistTurn(
  sessionId: string,
  userMessage: string,
  assistantMessage: string,
  setTitle: boolean,
): Promise<void> {
  const title = setTitle ? sessionTitleFromMessage(userMessage) : null;
  await query(
    `UPDATE chat_sessions
        SET updated_at = now(),
            title = COALESCE(title, $2),
            preview = $3
      WHERE id = $1`,
    [sessionId, title, sessionTitleFromMessage(userMessage, 120)],
  );
  await query(
    `INSERT INTO chat_messages (session_id, role, content) VALUES
       ($1, 'user', $2),
       ($1, 'assistant', $3)`,
    [sessionId, userMessage, assistantMessage],
  );
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    json(res, 400, { error: 'message is required' });
    return;
  }
  const context = (body.context ?? {}) as ChatContext;
  const scope: ChatScopeId =
    typeof body.scope === 'string' && body.scope in CHAT_SCOPES
      ? (body.scope as ChatScopeId)
      : 'general';
  const projectId =
    typeof body.projectId === 'string'
      ? body.projectId
      : typeof context.projectId === 'string'
        ? context.projectId
        : null;
  const subject = subjectKey(context);
  const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : WORKSPACE_ROOT;

  const session = await resolveSession(
    typeof body.sessionId === 'string' ? body.sessionId : undefined,
    projectId,
    scope,
    subject,
  );

  // Title only on the first turn of a brand-new row, or when title is still null.
  const existing = await query<{ title: string | null }>(
    'SELECT title FROM chat_sessions WHERE id = $1',
    [session.sessionId],
  );
  const needsTitle = !existing[0]?.title;

  res.writeHead(200, SSE_HEADERS);
  let id = 0;
  const send = (frame: StreamFrame) => {
    id += 1;
    res.write(sseFrame(id, frame));
  };
  // Tells the client which session to resume next turn.
  res.write(`event: session\ndata: ${JSON.stringify({ sessionId: session.sessionId })}\n\n`);

  // The domain gate, before the conversation is touched. A refused turn is persisted like
  // any other so the transcript stays honest, but it spawns no agy and never enters the
  // conversation's context.
  // The screen is instant, but an ambiguous message costs a classifier round-trip. Say so,
  // or the surface sits blank for ten seconds with nothing to show.
  send({ kind: 'status', event: { ts: new Date().toISOString(), type: 'starting', detail: 'checking scope' } });
  const verdict = await gate(message);
  if (!verdict.allow) {
    console.warn(`[gatekeeper] refused (${verdict.reason}): ${sessionTitleFromMessage(message, 120)}`);
    send({ kind: 'token', text: REFUSAL_TEXT });
    send({ kind: 'done', response: REFUSAL_TEXT });
    await persistTurn(session.sessionId, message, REFUSAL_TEXT, needsTitle);
    res.end();
    return;
  }

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const state = { sawText: false };
  let assistantText = '';
  try {
    for await (const raw of runAgy({
      prompt: scopedChatPrompt(message, scope, context),
      cwd,
      conversationId: session.conversationId,
      signal: controller.signal,
    })) {
      for (const frame of toFrames(raw, state)) {
        if (frame.kind === 'conversation') {
          await query(
            'UPDATE chat_sessions SET conversation_id = $1, updated_at = now() WHERE id = $2',
            [frame.conversationId, session.sessionId],
          );
        }
        if (frame.kind === 'token') {
          assistantText += frame.text;
        }
        if (frame.kind === 'done') {
          assistantText = frame.response || assistantText;
          await persistTurn(session.sessionId, message, assistantText, needsTitle);
        }
        send(frame);
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      const errMessage =
        err instanceof AgyError ? err.message : err instanceof Error ? err.message : String(err);
      send({ kind: 'error', message: errMessage });
    }
  } finally {
    res.end();
  }
}

async function handleListSessions(url: URL, res: ServerResponse): Promise<void> {
  const scopeParam = url.searchParams.get('scope') ?? 'general';
  const scope: ChatScopeId =
    scopeParam in CHAT_SCOPES ? (scopeParam as ChatScopeId) : 'general';
  const subject = url.searchParams.get('subject') ?? '';

  const rows = await query<{
    id: string;
    title: string | null;
    preview: string | null;
    updated_at: string;
    created_at: string;
  }>(
    `SELECT id, title, preview, updated_at::text, created_at::text
       FROM chat_sessions
      WHERE scope = $1 AND subject_key = $2
      ORDER BY updated_at DESC
      LIMIT 100`,
    [scope, subject],
  );

  json(res, 200, {
    sessions: rows.map((row) => ({
      id: row.id,
      title: row.title || 'Untitled chat',
      preview: row.preview,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
    })),
  });
}

async function handleGetSession(sessionId: string, res: ServerResponse): Promise<void> {
  const sessions = await query<{
    id: string;
    title: string | null;
    preview: string | null;
    scope: string;
    subject_key: string;
    updated_at: string;
  }>(
    `SELECT id, title, preview, scope, subject_key, updated_at::text
       FROM chat_sessions WHERE id = $1`,
    [sessionId],
  );
  const session = sessions[0];
  if (!session) {
    json(res, 404, { error: 'session not found' });
    return;
  }

  const messages = await query<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    created_at: string;
  }>(
    `SELECT id, role, content, created_at::text
       FROM chat_messages
      WHERE session_id = $1
      ORDER BY created_at ASC, id ASC`,
    [sessionId],
  );

  json(res, 200, {
    session: {
      id: session.id,
      title: session.title || 'Untitled chat',
      preview: session.preview,
      scope: session.scope,
      subjectKey: session.subject_key,
      updatedAt: session.updated_at,
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
    })),
  });
}

async function handleDeleteSession(sessionId: string, res: ServerResponse): Promise<void> {
  const rows = await query<{ id: string }>(
    'DELETE FROM chat_sessions WHERE id = $1 RETURNING id',
    [sessionId],
  );
  if (!rows[0]) {
    json(res, 404, { error: 'session not found' });
    return;
  }
  json(res, 200, { ok: true });
}

/** Live status feed for a background document run, with reconnect replay. */
async function handleRunEvents(
  runId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const buffer = getRunBuffer(runId);
  res.writeHead(200, SSE_HEADERS);

  const lastEventId = Number(req.headers['last-event-id'] ?? 0);
  const from = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0;
  for (const { id, frame } of buffer.since(from)) {
    res.write(sseFrame(id, frame));
  }

  if (buffer.finished) {
    res.end();
    return;
  }

  // An empty buffer for a run the database has already settled means the gateway
  // restarted and lost the in-memory frames. Without this the browser holds an open
  // stream that only ever emits pings, and the row spins in the UI forever.
  if (!buffer.frames.length) {
    const rows = await query<{ status: string; error: string | null }>(
      'SELECT status, error FROM workflow_runs WHERE id = $1',
      [runId],
    ).catch(() => []);
    const run = rows[0];
    if (!run || (run.status !== 'pending' && run.status !== 'running')) {
      const frame: StreamFrame =
        run?.status === 'completed'
          ? { kind: 'status', event: { ts: new Date().toISOString(), type: 'done' } }
          : { kind: 'error', message: run?.error ?? 'This run is no longer active.' };
      res.write(sseFrame(buffer.lastId + 1, frame));
      res.end();
      return;
    }
  }

  const unsubscribe = buffer.subscribe((id, frame) => {
    res.write(sseFrame(id, frame));
    if (frame.kind === 'done' || frame.kind === 'error') res.end();
  });
  // Comment ping keeps intermediaries from closing an idle connection.
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  res.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  void (async () => {
    try {
      if (path === '/health') {
        json(res, 200, {
          ok: true,
          workspace: WORKSPACE_ROOT,
          signedIn: await isSignedIn(),
        });
        return;
      }
      if (path === '/auth/status' && req.method === 'GET') {
        json(res, 200, await authStatus());
        return;
      }
      if (path === '/auth/start' && req.method === 'POST') {
        try {
          json(res, 200, await startAuth());
        } catch (err) {
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (path === '/auth/complete' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const code = typeof body.code === 'string' ? body.code : '';
        try {
          json(res, 200, await completeAuth(code));
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (path === '/auth/cancel' && req.method === 'POST') {
        json(res, 200, await cancelAuth());
        return;
      }
      if (path === '/auth/logout' && req.method === 'POST') {
        json(res, 200, await logoutAuth());
        return;
      }
      if (path === '/engine/reference' && req.method === 'GET') {
        try {
          json(res, 200, await engineReference());
        } catch (err) {
          json(res, 503, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      if (path === '/chat' && req.method === 'POST') {
        await handleChat(req, res);
        return;
      }
      if (path === '/chat/sessions' && req.method === 'GET') {
        await handleListSessions(url, res);
        return;
      }
      const sessionMatch = path.match(/^\/chat\/sessions\/([0-9a-fA-F-]{36})$/);
      if (sessionMatch && req.method === 'GET') {
        await handleGetSession(sessionMatch[1], res);
        return;
      }
      if (sessionMatch && req.method === 'DELETE') {
        await handleDeleteSession(sessionMatch[1], res);
        return;
      }
      const runMatch = path.match(/^\/runs\/([0-9a-fA-F-]{36})\/events$/);
      if (runMatch && req.method === 'GET') {
        await handleRunEvents(runMatch[1], req, res);
        return;
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent) res.end();
      else json(res, 500, { error: message });
    }
  })();
});

// An unhandled rejection must never take the gateway down mid-estimate.
process.on('unhandledRejection', (reason) => {
  console.error('[gateway] unhandled rejection:', reason);
});

await initDb();
startWorker();
// No-op unless INTAKE_ENABLED is set and IMAP credentials are present.
startMailIntake();
server.listen(PORT, () => {
  console.log(`[gateway] listening on :${PORT}, workspace ${WORKSPACE_ROOT}`);
});
