import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { query } from '@/lib/db';
import { pdfPathFor } from '@/lib/quote-draft';
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

    // A pre-approval draft and an approved quote are written to the SAME path, so once
    // downloaded they were indistinguishable on an estimator's disk - same filename, same
    // CBC template, and only a status cell inside to tell them apart. The download stays
    // available before approval (reviewing in Excel is real work), but it says what it is.
    const approved = await query<{ status: string }>(
      'SELECT status FROM quote_drafts WHERE run_id = $1',
      [id],
    )
      .then((rows) => rows[0]?.status === 'approved')
      .catch(() => false);

    // FR-10. The PDF is the customer-facing format and only exists once approved, so it
    // is requested explicitly rather than sniffed - a caller asking for it before it has
    // been generated should get a clear 404, not a silent spreadsheet.
    const wantsPdf = new URL(request.url).searchParams.get('format') === 'pdf';
    const sourcePath = wantsPdf ? pdfPathFor(run.output_path) : run.output_path;

    const base = basename(sourcePath).replace(/"/g, '');
    const name = approved ? base : `DRAFT_${base}`;

    let buffer: Buffer;
    try {
      buffer = await readFile(sourcePath);
    } catch {
      return Response.json(
        {
          error: wantsPdf
            ? 'No PDF for this run. The customer-facing PDF is written when the draft is approved.'
            : 'No estimate available for this run',
        },
        { status: 404 },
      );
    }

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': wantsPdf ? 'application/pdf' : XLSX_MIME,
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
