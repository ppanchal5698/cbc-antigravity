import { gatewayFetch, GATEWAY_URL, gatewayUnreachable, passthroughSse } from '@/lib/gateway';

// Streaming only works if this route is never statically evaluated.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  try {
    const upstream = await gatewayFetch(`/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // Abort the agy child as soon as the browser goes away.
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      return Response.json(
        { error: text || `gateway returned ${upstream.status}` },
        { status: upstream.status },
      );
    }
    return passthroughSse(upstream);
  } catch (err) {
    return gatewayUnreachable(err);
  }
}
