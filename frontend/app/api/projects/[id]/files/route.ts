import { query } from '@/lib/db';
import { attachFile } from '@/lib/intake';
import { hasAllowedExtension } from '@/lib/projects';
import type { Project, ProjectFile } from '@/types/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
// Multipart framing around the file itself: boundaries, headers, the trailing CRLFs.
const MULTIPART_SLACK = 1024 * 1024;

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/projects/[id]/files'>,
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const files = await query<ProjectFile>(
      'SELECT * FROM files WHERE project_id = $1 ORDER BY uploaded_at DESC',
      [id],
    );
    // A failed run that has already been retried is history, not state: showing it beside
    // the attempt that replaced it reads as two problems. The row stays in the table -
    // the error is the record of what the audit gate objected to - it just stops being
    // listed once a later attempt exists for the same file.
    const runs = await query(
      `SELECT r.id, r.file_id, r.status, r.output_path, r.error, r.created_at
         FROM workflow_runs r
        WHERE r.project_id = $1
          AND NOT (
            r.status = 'failed'
            AND EXISTS (
              SELECT 1 FROM workflow_runs newer
               WHERE newer.project_id = r.project_id
                 AND newer.file_id IS NOT DISTINCT FROM r.file_id
                 AND newer.created_at > r.created_at
            )
          )
        ORDER BY r.created_at DESC`,
      [id],
    );
    return Response.json({ files, runs });
  } catch (err) {
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

/**
 * Upload lands the file in the project's own folder and immediately enqueues
 * the estimate. There is deliberately no "run" button - the workflow starts the
 * moment the upload finishes.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<'/api/projects/[id]/files'>,
): Promise<Response> {
  const { id } = await ctx.params;

  // Before touching the body: `formData()` parses the whole request into memory, so an
  // oversized upload has already been buffered by the time `upload.size` can be read.
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + MULTIPART_SLACK) {
    return Response.json(
      { error: `File exceeds the ${MAX_UPLOAD_MB} MB limit` },
      { status: 413 },
    );
  }

  try {
    const projects = await query<Project>('SELECT * FROM projects WHERE id = $1', [id]);
    const project = projects[0];
    if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

    const form = await request.formData();
    const upload = form.get('file');
    if (!(upload instanceof File)) {
      return Response.json({ error: 'No file in request' }, { status: 400 });
    }
    if (upload.size === 0) {
      return Response.json({ error: 'File is empty' }, { status: 400 });
    }
    if (upload.size > MAX_UPLOAD_BYTES) {
      return Response.json(
        { error: `File exceeds the ${MAX_UPLOAD_MB} MB limit` },
        { status: 413 },
      );
    }
    if (!hasAllowedExtension(upload.name)) {
      return Response.json({ error: `Unsupported file type: ${upload.name}` }, { status: 415 });
    }

    // Writing the file, the two inserts and the cleanup-on-failure all live in
    // `attachFile`, so the mail poller lands a bid set exactly the way an upload does.
    const { file, run } = await attachFile(project, upload.name, upload.stream(), {
      size: upload.size,
      mime: upload.type || null,
    });

    return Response.json({ file, runId: run.id }, { status: 201 });
  } catch (err) {
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
