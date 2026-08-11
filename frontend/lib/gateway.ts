/** Client for the long-lived Antigravity gateway service. */
export const GATEWAY_URL = process.env.AGENT_URL || 'http://localhost:8787';

/**
 * Fetch the gateway, carrying the shared secret when one is configured.
 *
 * The gateway requires `GATEWAY_TOKEN` whenever it binds beyond loopback, because
 * `POST /chat` spawns agy with `--dangerously-skip-permissions` on the whole workspace.
 * Every proxy route goes through here so a new one cannot forget the header — that is the
 * whole reason this is a wrapper and not a header constant each caller spreads.
 *
 * Server-side only. The token is read from the environment and must never reach the
 * browser: these routes exist precisely so it does not.
 */
export function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = process.env.GATEWAY_TOKEN;
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${GATEWAY_URL}${path}`, { ...init, headers });
}

/** SSE responses are piped through untouched - buffering would defeat the point. */
export function passthroughSse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

export function gatewayUnreachable(err: unknown): Response {
  const detail = err instanceof Error ? err.message : String(err);
  return Response.json(
    { error: `Antigravity gateway unreachable at ${GATEWAY_URL}: ${detail}` },
    { status: 502 },
  );
}
