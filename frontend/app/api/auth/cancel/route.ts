import { GATEWAY_URL, gatewayUnreachable } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Abort an in-flight Antigravity sign-in broker session. */
export async function POST(): Promise<Response> {
  try {
    const response = await fetch(`${GATEWAY_URL}/auth/cancel`, {
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
