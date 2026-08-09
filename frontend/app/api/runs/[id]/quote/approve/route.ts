import { NextResponse } from 'next/server';
import { join } from 'node:path';
import { query } from '@/lib/db';
import { getDraftByRunId, markDraftApproved, regenerateWorkbook } from '@/lib/quote-draft';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    const runs = await query<{
      id: string;
      project_id: string;
      output_path: string | null;
      folder_path: string;
      slug: string;
    }>(
      `SELECT r.id, r.project_id, r.output_path,
              p.folder_path, p.slug
         FROM workflow_runs r
         JOIN projects p ON p.id = r.project_id
        WHERE r.id = $1`,
      [id],
    );
    const run = runs[0];
    if (!run) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const payload = await getDraftByRunId(id);
    if (!payload) {
      return NextResponse.json({ error: 'Quote draft not found' }, { status: 404 });
    }
    if (payload.draft.status === 'approved') {
      return NextResponse.json({ error: 'Draft is already approved' }, { status: 409 });
    }

    const active = payload.lines.filter((line) => !line.deleted_at);
    const pending = active.filter((line) => line.acceptance === 'pending');
    if (pending.length > 0) {
      return NextResponse.json(
        {
          error: `Accept or reject every line before approving (${pending.length} still pending).`,
          pending: pending.length,
        },
        { status: 400 },
      );
    }

    const accepted = active.filter((line) => line.acceptance === 'accepted');
    if (accepted.length === 0) {
      return NextResponse.json(
        { error: 'At least one accepted line is required to approve.' },
        { status: 400 },
      );
    }

    // Claim the approval before writing the workbook. Two approvals racing would
    // otherwise both regenerate the file, and the loser's lines would be what landed.
    const approvedDraft = await markDraftApproved(payload.draft.id);
    if (!approvedDraft) {
      return NextResponse.json({ error: 'Draft is already approved' }, { status: 409 });
    }

    const outputPath =
      run.output_path || join(run.folder_path, `CBC_Material_Quotation_${run.slug}.xlsx`);

    await regenerateWorkbook(outputPath, approvedDraft, payload.lines, {
      acceptedOnly: true,
    });

    await query(`UPDATE workflow_runs SET output_path = $1 WHERE id = $2`, [outputPath, id]);

    return NextResponse.json({
      draft: approvedDraft,
      downloadUrl: `/api/runs/${id}/download`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
