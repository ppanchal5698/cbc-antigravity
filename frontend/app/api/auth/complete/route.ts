import { gatewayFetch, GATEWAY_URL, gatewayUnreachable } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Submit the Google authorization code to the live broker session. */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  try {
    const response = await gatewayFetch(`/auth/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // Waiting for token write after code paste.
      signal: AbortSignal.timeout(200_000),
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    return gatewayUnreachable(err);
  }
}
