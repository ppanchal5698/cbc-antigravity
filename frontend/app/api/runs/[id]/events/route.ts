import { gatewayFetch, GATEWAY_URL, gatewayUnreachable, passthroughSse } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Live status feed for a background estimate, proxied from the gateway. */
export async function GET(
  request: Request,
  ctx: RouteContext<'/api/runs/[id]/events'>,
): Promise<Response> {
  const { id } = await ctx.params;
  const lastEventId = request.headers.get('last-event-id');
  try {
    const upstream = await gatewayFetch(`/runs/${id}/events`, {
      headers: lastEventId ? { 'Last-Event-ID': lastEventId } : undefined,
      signal: request.signal,
    });
    if (!upstream.body) {
      return Response.json({ error: 'gateway returned no stream' }, { status: 502 });
    }
    return passthroughSse(upstream);
  } catch (err) {
    return gatewayUnreachable(err);
  }
}
