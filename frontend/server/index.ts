/**
 * The Antigravity gateway.
 *
 * Long-lived process that owns the connection to the Antigravity CLI. It is a
 * singleton service, never spawned per request: chat turns resume conversations
 * by id, and the document worker runs in the same process so a browser refresh
 * or a Next.js restart cannot orphan an in-flight estimate.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chatPrompt, runAgy, AgyError, WORKSPACE_ROOT } from './agy.ts';
import { getRunBuffer, sseFrame, toFrames } from './events.ts';
import { engineReference } from './engine-ref.ts';
import { initDb, query } from './db.ts';
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

/** Resolves the agy conversation id for a chat session, creating the row if new. */
async function resolveSession(
  sessionId: string | undefined,
  projectId: string | null,
): Promise<{ sessionId: string; conversationId: string | null }> {
  if (sessionId) {
    const rows = await query<{ id: string; conversation_id: string | null }>(
      'SELECT id, conversation_id FROM chat_sessions WHERE id = $1',
      [sessionId],
    );
    if (rows[0]) return { sessionId: rows[0].id, conversationId: rows[0].conversation_id };
  }
  const rows = await query<{ id: string }>(
    'INSERT INTO chat_sessions (project_id) VALUES ($1) RETURNING id',
    [projectId],
  );
  return { sessionId: rows[0].id, conversationId: null };
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    json(res, 400, { error: 'message is required' });
    return;
  }
  const projectId = typeof body.projectId === 'string' ? body.projectId : null;
  const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : WORKSPACE_ROOT;

  const session = await resolveSession(
    typeof body.sessionId === 'string' ? body.sessionId : undefined,
    projectId,
  );

  res.writeHead(200, SSE_HEADERS);
  let id = 0;
  const send = (frame: StreamFrame) => {
    id += 1;
    res.write(sseFrame(id, frame));
  };
  // Tells the client which session to resume next turn.
  res.write(`event: session\ndata: ${JSON.stringify({ sessionId: session.sessionId })}\n\n`);

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const state = { sawText: false };
  try {
    for await (const raw of runAgy({
      prompt: chatPrompt(message),
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
        send(frame);
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      const message =
        err instanceof AgyError ? err.message : err instanceof Error ? err.message : String(err);
      send({ kind: 'error', message });
    }
  } finally {
    res.end();
  }
}

/** Live status feed for a background document run, with reconnect replay. */
function handleRunEvents(runId: string, req: IncomingMessage, res: ServerResponse): void {
  const buffer = getRunBuffer(runId);
  res.writeHead(200, SSE_HEADERS);

  const lastEventId = Number(req.headers['last-event-id'] ?? 0);
  const from = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0;
  for (let i = from; i < buffer.frames.length; i += 1) {
    res.write(sseFrame(i + 1, buffer.frames[i]));
  }

  if (buffer.finished) {
    res.end();
    return;
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
        json(res, 200, { ok: true, workspace: WORKSPACE_ROOT });
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
      const runMatch = path.match(/^\/runs\/([0-9a-fA-F-]{36})\/events$/);
      if (runMatch && req.method === 'GET') {
        handleRunEvents(runMatch[1], req, res);
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
server.listen(PORT, () => {
  console.log(`[gateway] listening on :${PORT}, workspace ${WORKSPACE_ROOT}`);
});
