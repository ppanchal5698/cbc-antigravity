import { gatewayFetch, GATEWAY_URL, gatewayUnreachable } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Clear the Antigravity OAuth token in the agent container. */
export async function POST(): Promise<Response> {
  try {
    const response = await gatewayFetch(`/auth/logout`, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    return gatewayUnreachable(err);
  }
}
