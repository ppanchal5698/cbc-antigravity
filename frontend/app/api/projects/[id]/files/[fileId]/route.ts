import { access, rename, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { query } from '@/lib/db';
import { resolveInside, safeFilename } from '@/lib/projects';
import type { Project, ProjectFile } from '@/types/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/projects/[id]/files/[fileId]'>,
): Promise<Response> {
  const { id, fileId } = await ctx.params;
  try {
    const file = await loadFile(id, fileId);
    if (!file) return Response.json({ error: 'File not found' }, { status: 404 });
    return Response.json({ file });
  } catch (err) {
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  ctx: RouteContext<'/api/projects/[id]/files/[fileId]'>,
): Promise<Response> {
  const { id, fileId } = await ctx.params;

  let filenameRaw: string;
  try {
    const body = (await request.json()) as { filename?: unknown };
    filenameRaw = typeof body.filename === 'string' ? body.filename.trim() : '';
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!filenameRaw) {
    return Response.json({ error: 'Filename is required' }, { status: 400 });
  }

  try {
    const projects = await query<Project>('SELECT * FROM projects WHERE id = $1', [id]);
    const project = projects[0];
    if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

    const file = await loadFile(id, fileId);
    if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

    const filename = safeFilename(filenameRaw);
    if (filename === file.filename) {
      return Response.json({ file });
    }

    const target = resolveInside(project.folder_path, filename);
    try {
      await access(target, fsConstants.F_OK);
      return Response.json(
        { error: `A file named ${filename} already exists in this project` },
        { status: 409 },
      );
    } catch {
      // Target does not exist — safe to rename.
    }

    await rename(file.path, target);

    try {
      const rows = await query<ProjectFile>(
        `UPDATE files SET filename = $1, path = $2 WHERE id = $3 AND project_id = $4 RETURNING *`,
        [filename, target, fileId, id],
      );
      return Response.json({ file: rows[0] });
    } catch (err) {
      await rename(target, file.path).catch(() => {});
      throw err;
    }
  } catch (err) {
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  ctx: RouteContext<'/api/projects/[id]/files/[fileId]'>,
): Promise<Response> {
  const { id, fileId } = await ctx.params;
  try {
    const file = await loadFile(id, fileId);
    if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

    await query('DELETE FROM files WHERE id = $1 AND project_id = $2', [fileId, id]);
    await rm(file.path, { force: true }).catch(() => {});

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

async function loadFile(projectId: string, fileId: string): Promise<ProjectFile | undefined> {
  const rows = await query<ProjectFile>(
    'SELECT * FROM files WHERE id = $1 AND project_id = $2',
    [fileId, projectId],
  );
  return rows[0];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
