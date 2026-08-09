import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@/lib/db';
import { PROJECTS_DIR, uniqueSlug } from '@/lib/projects';
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
    // The row lands first and the folder is created only once it has committed, so a
    // folder can never outlive a rolled-back insert. Doing it the other way round left
    // an orphan directory behind whenever COMMIT itself failed, and `mkdir` is not
    // transactional however deep inside the transaction it is called.
    let project: Project | undefined;
    let slug = '';

    for (let attempt = 0; attempt < 2 && !project; attempt += 1) {
      const existing = await query<{ slug: string }>('SELECT slug FROM projects');
      const taken = new Set(existing.map((row) => row.slug));
      // Two requests can pass this check at once; the unique index is the real
      // arbiter and the retry below is what makes losing that race harmless.
      if (attempt > 0) taken.add(slug);
      slug = uniqueSlug(name, taken);

      try {
        const rows = await query<Project>(
          `INSERT INTO projects (name, slug, folder_path)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [name, slug, join(PROJECTS_DIR, slug)],
        );
        project = rows[0];
      } catch (err) {
        // A name collision is the user's to resolve. A slug collision is ours - two
        // different names can slugify the same way - and used to surface as
        // "a project with that name already exists", which was simply untrue.
        if (violated(err, 'name')) {
          return Response.json(
            { error: 'A project with that name already exists' },
            { status: 409 },
          );
        }
        if (!violated(err, 'slug') || attempt === 1) throw err;
      }
    }

    if (!project) {
      return Response.json({ error: 'Could not allocate a project folder name' }, { status: 409 });
    }

    try {
      await mkdir(project.folder_path, { recursive: true });
    } catch (err) {
      await query('DELETE FROM projects WHERE id = $1', [project.id]).catch(() => {});
      return Response.json(
        { error: `Could not create the project folder: ${message(err)}` },
        { status: 500 },
      );
    }

    return Response.json({ project }, { status: 201 });
  } catch (err) {
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

/** True for a unique-violation on the named column's constraint. */
function violated(err: unknown, column: 'name' | 'slug'): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  if ((err as { code?: string }).code !== '23505') return false;
  const constraint = (err as { constraint?: string }).constraint ?? '';
  return constraint.includes(column);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
