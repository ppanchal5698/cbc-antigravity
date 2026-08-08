import { listProducts } from '@/lib/catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/shelf/[folder]/products'>,
): Promise<Response> {
  const { folder } = await ctx.params;
  const url = new URL(request.url);
  try {
    const result = listProducts({
      folder: decodeURIComponent(folder),
      division: url.searchParams.get('division') || undefined,
      q: url.searchParams.get('q') || undefined,
      limit: Number(url.searchParams.get('limit') || 100),
      offset: Number(url.searchParams.get('offset') || 0),
    });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
