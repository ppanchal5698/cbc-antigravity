import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { query } from '@/lib/db';
import type { Project, ProjectFile } from '@/types/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  ctx: RouteContext<'/api/projects/[id]/files/[fileId]/download'>,
): Promise<Response> {
  const { id, fileId } = await ctx.params;
  try {
    const projects = await query<Project>('SELECT * FROM projects WHERE id = $1', [id]);
    const project = projects[0];
    if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

    const rows = await query<ProjectFile>(
      'SELECT * FROM files WHERE id = $1 AND project_id = $2',
      [fileId, id],
    );
    const file = rows[0];
    if (!file) return Response.json({ error: 'File not found' }, { status: 404 });

    // Path comes from the DB row only — never from the request. Confirm it still
    // sits under the project folder before streaming.
    if (!isInside(project.folder_path, file.path)) {
      return Response.json({ error: 'File path is outside the project folder' }, { status: 500 });
    }

    try {
      await access(file.path, fsConstants.R_OK);
    } catch {
      return Response.json({ error: 'File is missing on disk' }, { status: 404 });
    }

    const disposition =
      new URL(request.url).searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';
    const safeName = file.filename.replace(/"/g, '');

    const nodeStream = createReadStream(file.path);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers = new Headers({
      'Content-Disposition': `${disposition}; filename="${safeName}"`,
      'Cache-Control': 'no-store',
    });
    if (file.mime) headers.set('Content-Type', file.mime);
    else headers.set('Content-Type', 'application/octet-stream');
    if (file.size_bytes != null) headers.set('Content-Length', String(file.size_bytes));

    return new Response(webStream, { headers });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

function isInside(parent: string, child: string): boolean {
  const parentResolved = resolve(parent);
  const target = resolve(child);
  const prefix = parentResolved.endsWith(sep) ? parentResolved : parentResolved + sep;
  return target === parentResolved || target.startsWith(prefix);
}
