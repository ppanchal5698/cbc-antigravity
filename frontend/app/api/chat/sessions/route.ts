import { gatewayFetch, GATEWAY_URL, gatewayUnreachable } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Proxies session list for one chat surface (scope + subject). */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const qs = url.searchParams.toString();
  try {
    const upstream = await gatewayFetch(`/chat/sessions${qs ? `?${qs}` : ''}`,
      { signal: request.signal, cache: 'no-store' },
    );
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    return gatewayUnreachable(err);
  }
}
