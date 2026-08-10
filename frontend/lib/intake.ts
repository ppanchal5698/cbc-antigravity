/**
 * Creating a project and attaching a bid set to it, without an HTTP request.
 *
 * This logic used to live inline in the two route handlers, which meant the only way to
 * start an estimate was for a browser to post a form. The mail poller needs the same four
 * steps from inside the gateway, and a second copy of "insert the row, make the folder,
 * stream the file, enqueue the run" would drift from the first the moment either changed.
 *
 * The routes keep their HTTP concerns - status codes, content-length pre-checks, multipart
 * parsing - and call in here for the work.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { query, withTransaction } from './db.ts';
import { PROJECTS_DIR, resolveInside, safeFilename, uniqueSlug } from './projects.ts';
import type { Project, ProjectFile } from '../types/events.ts';

/** True for a unique-violation on the named column's constraint. */
export function violated(err: unknown, column: 'name' | 'slug'): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  if ((err as { code?: string }).code !== '23505') return false;
  const constraint = (err as { constraint?: string }).constraint ?? '';
  return constraint.includes(column);
}

/**
 * `projects.name` is UNIQUE, and `uniqueSlug` only dedupes the slug.
 *
 * A person typing a name sees "already exists" and picks another. Mail has nobody to ask:
 * two bid sets emailed with the subject "Bid set" are two different jobs, and the second
 * must not fail on a 23505. Qualify by the day it arrived first, since that is the thing
 * an estimator would use to tell them apart, then fall back to a counter.
 */
export function uniqueName(name: string, taken: Set<string>, today: string): string {
  const base = name.slice(0, 120);
  if (!taken.has(base)) return base;
  const dated = `${base.slice(0, 106)} (${today})`;
  if (!taken.has(dated)) return dated;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${dated} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${dated} ${Date.now()}`;
}

export type CreateProjectResult =
  | { ok: true; project: Project }
  | { ok: false; reason: 'name_taken' | 'no_slug' | 'folder_failed'; detail?: string };

/**
 * Insert the project row, then create its folder.
 *
 * The ordering is deliberate and load-bearing: the row lands first and the folder is
 * created only once it has committed, so a folder can never outlive a rolled-back insert.
 * Doing it the other way round left an orphan directory behind whenever COMMIT itself
 * failed, and `mkdir` is not transactional however deep inside the transaction it is called.
 */
export async function createProject(name: string): Promise<CreateProjectResult> {
  let project: Project | undefined;
  let slug = '';

  for (let attempt = 0; attempt < 2 && !project; attempt += 1) {
    const existing = await query<{ slug: string }>('SELECT slug FROM projects');
    const taken = new Set(existing.map((row) => row.slug));
    // Two requests can pass this check at once; the unique index is the real arbiter and
    // the retry below is what makes losing that race harmless.
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
      // A name collision is the caller's to resolve. A slug collision is ours - two
      // different names can slugify the same way - and used to surface as "a project with
      // that name already exists", which was simply untrue.
      if (violated(err, 'name')) return { ok: false, reason: 'name_taken' };
      if (!violated(err, 'slug') || attempt === 1) throw err;
    }
  }

  if (!project) return { ok: false, reason: 'no_slug' };

  try {
    await mkdir(project.folder_path, { recursive: true });
  } catch (err) {
    await query('DELETE FROM projects WHERE id = $1', [project.id]).catch(() => {});
    return {
      ok: false,
      reason: 'folder_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, project };
}

/** A name the caller can be sure will not collide, resolved against the live table. */
export async function createProjectDeduped(name: string): Promise<CreateProjectResult> {
  const today = new Date().toISOString().slice(0, 10);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows = await query<{ name: string }>('SELECT name FROM projects');
    const taken = new Set(rows.map((r) => r.name));
    const result = await createProject(uniqueName(name, taken, today));
    if (result.ok || result.reason !== 'name_taken') return result;
  }
  return { ok: false, reason: 'name_taken' };
}

/**
 * Write a bid set into the project's folder and queue its estimate.
 *
 * `source` is a stream or a buffer: an upload arrives as a web stream, a mail attachment
 * as bytes already in memory. Both land the same way.
 *
 * The run row is the whole handoff - `status` defaults to 'pending' and the worker's poll
 * claims it. The file row and the run row go in one transaction so a run can never point
 * at a file that was rolled back.
 */
export async function attachFile(
  project: Pick<Project, 'id' | 'folder_path'>,
  originalName: string,
  source: Readable | ReadableStream | Uint8Array,
  opts: { size?: number; mime?: string | null } = {},
): Promise<{ file: ProjectFile; run: { id: string } }> {
  const filename = safeFilename(originalName);
  const target = resolveInside(project.folder_path, filename);

  try {
    // Streamed rather than buffering the whole thing again: a bid set can be 200 MB, and
    // holding a second full copy to write it was measurable.
    const input =
      source instanceof Uint8Array
        ? Readable.from(Buffer.from(source))
        : source instanceof Readable
          ? source
          : Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(input, createWriteStream(target));

    const size =
      opts.size ?? (source instanceof Uint8Array ? source.byteLength : undefined) ?? 0;

    return await withTransaction(async (client) => {
      const fileRows = await client.query<ProjectFile>(
        `INSERT INTO files (project_id, filename, path, size_bytes, mime)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [project.id, filename, target, size, opts.mime ?? null],
      );
      const runRows = await client.query<{ id: string }>(
        `INSERT INTO workflow_runs (project_id, file_id) VALUES ($1, $2) RETURNING id`,
        [project.id, fileRows.rows[0]!.id],
      );
      return { file: fileRows.rows[0]!, run: runRows.rows[0]! };
    });
  } catch (err) {
    // A half-written file with no row behind it would be picked up by the folder-wide
    // estimate prompt as if it were a real bid document.
    await rm(target, { force: true }).catch(() => {});
    throw err;
  }
}
