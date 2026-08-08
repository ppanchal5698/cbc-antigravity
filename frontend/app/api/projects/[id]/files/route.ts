import { writeFile } from 'node:fs/promises';
import { query, withTransaction } from '@/lib/db';
import { hasAllowedExtension, resolveInside, safeFilename } from '@/lib/projects';
import type { Project, ProjectFile } from '@/types/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);

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
    if (upload.size > MAX_UPLOAD_MB * 1024 * 1024) {
      return Response.json(
        { error: `File exceeds the ${MAX_UPLOAD_MB} MB limit` },
        { status: 413 },
      );
    }
    if (!hasAllowedExtension(upload.name)) {
      return Response.json({ error: `Unsupported file type: ${upload.name}` }, { status: 415 });
    }

    const filename = safeFilename(upload.name);
    const target = resolveInside(project.folder_path, filename);
    await writeFile(target, Buffer.from(await upload.arrayBuffer()));

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
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
