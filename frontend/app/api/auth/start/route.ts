import { GATEWAY_URL, gatewayUnreachable } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Start (or reuse) the PTY OAuth broker and return the Google authorization URL. */
export async function POST(): Promise<Response> {
  try {
    const response = await fetch(`${GATEWAY_URL}/auth/start`, {
      method: 'POST',
      // Broker may wait up to ~90s for the URL.
      signal: AbortSignal.timeout(120_000),
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
