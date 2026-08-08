/** Project naming and filesystem safety. */
import { resolve, sep } from 'node:path';

export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';

/** Project folders live beside the bid sets the CBC workflow already reads. */
export const PROJECTS_DIR = process.env.PROJECTS_DIR || `${WORKSPACE_ROOT}${sep}plans`;

/** Windows reserved device names; a folder called CON or LPT1 cannot be created. */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!slug || RESERVED.has(slug)) return `project-${slug || 'unnamed'}`;
  return slug;
}

/** `taken` is the set of slugs already in use; returns slug, slug-2, slug-3... */
export function uniqueSlug(name: string, taken: Set<string>): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Strips any directory component and characters a filesystem will refuse. */
export function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() || 'upload';
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 180) || 'upload';
}

export { ALLOWED_EXTENSIONS, hasAllowedExtension } from './uploads';

/**
 * Resolves `child` under `parent` and refuses anything that escapes it.
 * Last line of defence behind `safeFilename`.
 */
export function resolveInside(parent: string, child: string): string {
  const parentResolved = resolve(parent);
  const target = resolve(parentResolved, child);
  const prefix = parentResolved.endsWith(sep) ? parentResolved : parentResolved + sep;
  if (target !== parentResolved && !target.startsWith(prefix)) {
    throw new Error('path escapes the project folder');
  }
  return target;
}
