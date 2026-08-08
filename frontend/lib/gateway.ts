/** Client for the long-lived Antigravity gateway service. */
export const GATEWAY_URL = process.env.AGENT_URL || 'http://localhost:8787';

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
