import { query } from '@/lib/db';
import type { WorkflowRun } from '@/types/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/runs/[id]'>,
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const rows = await query<WorkflowRun>('SELECT * FROM workflow_runs WHERE id = $1', [id]);
    const run = rows[0];
    if (!run) return Response.json({ error: 'Run not found' }, { status: 404 });
    return Response.json({
      run,
      downloadUrl: run.status === 'completed' && run.output_path ? `/api/runs/${id}/download` : null,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
