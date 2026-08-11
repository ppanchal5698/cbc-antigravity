import { gatewayFetch, GATEWAY_URL } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Antigravity OAuth status (token file + in-flight broker session). */
export async function GET(): Promise<Response> {
  try {
    const response = await gatewayFetch(`/auth/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Antigravity gateway unreachable at ${GATEWAY_URL}: ${detail}` },
      { status: 502 },
    );
  }
}
