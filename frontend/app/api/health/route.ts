import { GATEWAY_URL } from '@/lib/gateway';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Liveness of the Antigravity gateway, for the status dot in the top nav. */
export async function GET(): Promise<Response> {
  try {
    const response = await fetch(`${GATEWAY_URL}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return Response.json({ ok: false }, { status: 200 });
    const body = (await response.json()) as { ok?: boolean; workspace?: string };
    return Response.json({ ok: Boolean(body.ok), workspace: body.workspace ?? null });
  } catch {
    return Response.json({ ok: false }, { status: 200 });
  }
}
