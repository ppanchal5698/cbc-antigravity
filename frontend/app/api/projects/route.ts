import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { query, withTransaction } from '@/lib/db';
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
    const existing = await query<{ slug: string }>('SELECT slug FROM projects');
    const slug = uniqueSlug(name, new Set(existing.map((row) => row.slug)));
    const folderPath = join(PROJECTS_DIR, slug);

    // The folder is created inside the transaction and removed if the insert
    // fails, so a row never exists without its directory and vice versa.
    const project = await withTransaction(async (client) => {
      await mkdir(folderPath, { recursive: true });
      try {
        const result = await client.query<Project>(
          `INSERT INTO projects (name, slug, folder_path)
           VALUES ($1, $2, $3)
           RETURNING *`,
          [name, slug, folderPath],
        );
        return result.rows[0];
      } catch (err) {
        await rm(folderPath, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
    });

    return Response.json({ project }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return Response.json({ error: 'A project with that name already exists' }, { status: 409 });
    }
    return Response.json({ error: message(err) }, { status: 500 });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
