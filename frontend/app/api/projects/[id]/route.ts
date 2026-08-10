import { rm } from 'node:fs/promises';
import { query } from '@/lib/db';
import type { Project } from '@/types/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/projects/[id]'>,
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const rows = await query<Project>('SELECT * FROM projects WHERE id = $1', [id]);
    const project = rows[0];
    if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });
    return Response.json({ project });
  } catch (err) {
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  ctx: RouteContext<'/api/projects/[id]'>,
): Promise<Response> {
  const { id } = await ctx.params;

  let name: string;
  try {
    const body = (await request.json()) as { name?: unknown };
    name = typeof body.name === 'string' ? body.name.trim() : '';
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!name) return Response.json({ error: 'Project name is required' }, { status: 400 });
  if (name.length > 120) {
    return Response.json({ error: 'Project name is too long (max 120)' }, { status: 400 });
  }

  try {
    const existing = await query<Project>('SELECT * FROM projects WHERE id = $1', [id]);
    if (!existing[0]) return Response.json({ error: 'Project not found' }, { status: 404 });

    const rows = await query<Project>(
      `UPDATE projects SET name = $1 WHERE id = $2 RETURNING *`,
      [name, id],
    );
    return Response.json({ project: rows[0] });
  } catch (err) {
    if (violated(err, 'name')) {
      return Response.json(
        { error: 'A project with that name already exists' },
        { status: 409 },
      );
    }
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  ctx: RouteContext<'/api/projects/[id]'>,
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const existing = await query<Project>('SELECT * FROM projects WHERE id = $1', [id]);
    const project = existing[0];
    if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

    const active = await query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM workflow_runs
        WHERE project_id = $1 AND status IN ('pending', 'running')`,
      [id],
    );
    if ((active[0]?.count ?? 0) > 0) {
      return Response.json(
        { error: 'Cannot delete a project while an estimate is pending or running' },
        { status: 409 },
      );
    }

    await query('DELETE FROM projects WHERE id = $1', [id]);
    await rm(project.folder_path, { recursive: true, force: true }).catch(() => {});

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

function violated(err: unknown, column: 'name' | 'slug'): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  if ((err as { code?: string }).code !== '23505') return false;
  const constraint = (err as { constraint?: string }).constraint ?? '';
  return constraint.includes(column);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
