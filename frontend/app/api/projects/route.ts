import { query } from '@/lib/db';
import { createProject } from '@/lib/intake';
import type { Project } from '@/types/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  try {
    const projects = await query<Project>(
      `SELECT p.*,
              (SELECT count(*) FROM files f WHERE f.project_id = p.id)::int AS file_count
         FROM projects p
        ORDER BY p.created_at DESC`,
    );
    return Response.json({ projects });
  } catch (err) {
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
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
    // A person typing a name is told to pick another; the mail poller has nobody to ask,
    // so it calls `createProjectDeduped` instead. Same creation path either way.
    const result = await createProject(name);
    if (result.ok) return Response.json({ project: result.project }, { status: 201 });

    if (result.reason === 'name_taken') {
      return Response.json({ error: 'A project with that name already exists' }, { status: 409 });
    }
    if (result.reason === 'no_slug') {
      return Response.json({ error: 'Could not allocate a project folder name' }, { status: 409 });
    }
    return Response.json(
      { error: `Could not create the project folder: ${result.detail ?? 'unknown'}` },
      { status: 500 },
    );
  } catch (err) {
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
