import { GATEWAY_URL, gatewayUnreachable } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** Load one session and its persisted messages. */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  try {
    const upstream = await fetch(`${GATEWAY_URL}/chat/sessions/${id}`, {
      signal: request.signal,
      cache: 'no-store',
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    return gatewayUnreachable(err);
  }
}

/** Delete a session (messages cascade). */
export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const { id } = await params;
  try {
    const upstream = await fetch(`${GATEWAY_URL}/chat/sessions/${id}`, {
      method: 'DELETE',
      signal: request.signal,
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    return gatewayUnreachable(err);
  }
}
