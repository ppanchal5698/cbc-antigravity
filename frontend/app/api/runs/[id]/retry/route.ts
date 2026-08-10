import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import type { WorkflowRun } from '@/types/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Re-queue a finished run against the same file.
 *
 * A new row rather than a reset of the old one: the failure is the record of what the
 * audit gate objected to, and an estimator comparing attempts needs both. The worker
 * claims `pending` rows on its own poll, so inserting one is the whole handoff.
 */
export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const rows = await query<WorkflowRun>('SELECT * FROM workflow_runs WHERE id = $1', [id]);
    const run = rows[0];
    if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

    // Retrying something still in flight would run the same bid set twice concurrently.
    if (run.status === 'pending' || run.status === 'running') {
      return NextResponse.json(
        { error: 'That estimate is still running.' },
        { status: 409 },
      );
    }

    const existing = await query<{ id: string }>(
      `SELECT id FROM workflow_runs
        WHERE project_id = $1 AND file_id IS NOT DISTINCT FROM $2
          AND status IN ('pending', 'running')
        LIMIT 1`,
      [run.project_id, run.file_id],
    );
    if (existing[0]) {
      return NextResponse.json(
        { error: 'An estimate for this file is already queued.', runId: existing[0].id },
        { status: 409 },
      );
    }

    const created = await query<{ id: string }>(
      `INSERT INTO workflow_runs (project_id, file_id) VALUES ($1, $2) RETURNING id`,
      [run.project_id, run.file_id],
    );
    return NextResponse.json({ runId: created[0]!.id }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
