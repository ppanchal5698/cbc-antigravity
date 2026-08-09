import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { getDraftByRunId } from '@/lib/quote-draft';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    const runs = await query<{ id: string; project_id: string; status: string }>(
      'SELECT id, project_id, status FROM workflow_runs WHERE id = $1',
      [id],
    );
    if (!runs[0]) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const payload = await getDraftByRunId(id);
    if (!payload) {
      return NextResponse.json(
        { error: 'No quote draft for this run yet. Re-run the estimate after upgrading.' },
        { status: 404 },
      );
    }

    const lines = payload.lines.filter((line) => !line.deleted_at);
    return NextResponse.json({
      draft: payload.draft,
      lines,
      run: runs[0],
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
