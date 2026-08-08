import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { query } from '@/lib/db';
import { resolveInside } from '@/lib/projects';
import type { Project } from '@/types/events';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export type TreeEntry = {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size: number;
  modified: string;
  depth: number;
};

const MAX_DEPTH = 4;
const MAX_ENTRIES = 500;

/**
 * The project's own folder, and nothing above it. Every path is resolved
 * through `resolveInside`, so a symlink or a crafted name cannot walk out.
 */
async function walk(root: string, dir: string, depth: number, out: TreeEntry[]): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (out.length >= MAX_ENTRIES) return;
    if (entry.name.startsWith('.')) continue;

    let full: string;
    try {
      full = resolveInside(root, relative(root, join(dir, entry.name)));
    } catch {
      continue;
    }

    const info = await stat(full).catch(() => null);
    if (!info) continue;

    out.push({
      name: entry.name,
      path: relative(root, full).split(sep).join('/'),
      kind: entry.isDirectory() ? 'directory' : 'file',
      size: info.size,
      modified: info.mtime.toISOString(),
      depth,
    });

    if (entry.isDirectory()) await walk(root, full, depth + 1, out);
  }
}

export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/projects/[id]/tree'>,
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const projects = await query<Project>('SELECT * FROM projects WHERE id = $1', [id]);
    const project = projects[0];
    if (!project) return Response.json({ error: 'Project not found' }, { status: 404 });

    const entries: TreeEntry[] = [];
    await walk(project.folder_path, project.folder_path, 0, entries);
    return Response.json({ root: project.folder_path, entries });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
