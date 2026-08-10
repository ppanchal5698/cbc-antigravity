import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { query } from '@/lib/db';
import type { WorkflowRun } from '@/types/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/runs/[id]/download'>,
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const rows = await query<WorkflowRun>(
      'SELECT * FROM workflow_runs WHERE id = $1 AND status = $2',
      [id, 'completed'],
    );
    const run = rows[0];
    // The path comes from the worker, never from the request - no traversal surface.
    if (!run?.output_path) {
      return Response.json({ error: 'No estimate available for this run' }, { status: 404 });
    }

    const disposition =
      new URL(request.url).searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';
    const name = basename(run.output_path).replace(/"/g, '');

    const buffer = await readFile(run.output_path);
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': XLSX_MIME,
        'Content-Disposition': `${disposition}; filename="${name}"`,
        'Content-Length': String(buffer.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
