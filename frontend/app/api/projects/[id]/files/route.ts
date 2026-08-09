import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { query, withTransaction } from '@/lib/db';
import { hasAllowedExtension, resolveInside, safeFilename } from '@/lib/projects';
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
    const runs = await query(
      `SELECT id, file_id, status, output_path, error, created_at
         FROM workflow_runs WHERE project_id = $1 ORDER BY created_at DESC`,
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

  let target: string | null = null;
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

    const filename = safeFilename(upload.name);
    target = resolveInside(project.folder_path, filename);
    // Streamed rather than `Buffer.from(await upload.arrayBuffer())`, which held a
    // second full copy of a file that can be 200 MB.
    await pipeline(
      Readable.fromWeb(upload.stream() as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(target),
    );

    const { file, run } = await withTransaction(async (client) => {
      const fileRows = await client.query<ProjectFile>(
        `INSERT INTO files (project_id, filename, path, size_bytes, mime)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [project.id, filename, target, upload.size, upload.type || null],
      );
      const runRows = await client.query<{ id: string }>(
        `INSERT INTO workflow_runs (project_id, file_id) VALUES ($1, $2) RETURNING id`,
        [project.id, fileRows.rows[0].id],
      );
      return { file: fileRows.rows[0], run: runRows.rows[0] };
    });

    return Response.json({ file, runId: run.id }, { status: 201 });
  } catch (err) {
    // A half-written file with no row behind it would be picked up by the folder-wide
    // estimate prompt as if it were a real bid document.
    if (target) await rm(target, { force: true }).catch(() => {});
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
