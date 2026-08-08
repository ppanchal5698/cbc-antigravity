import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Read-only access to the two SQLite indexes the MCP servers maintain.
 *
 * Node 24 ships `node:sqlite`, so this needs no dependency. Both files are
 * opened read-only and never written: the MCP servers own them, and the UI is
 * a reader that must never race an indexing run.
 */
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || '/workspace';

const CACHE_ROOT = join(WORKSPACE_ROOT, '.agent', 'cache');

export const CATALOG_DB = join(CACHE_ROOT, 'catalog-intelligence', 'catalog.db');
export const PLAN_DB = join(CACHE_ROOT, 'building-plan-intelligence', 'index.db');

type HandleEntry = {
  db: DatabaseSync;
  mtimeMs: number;
  size: number;
};

const handles = new Map<string, HandleEntry>();

function fileFingerprint(path: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function closeHandle(path: string): void {
  const existing = handles.get(path);
  if (!existing) return;
  handles.delete(path);
  try {
    existing.db.close();
  } catch {
    // Already closed or unusable — drop it from the map either way.
  }
}

/** Drop a cached handle so the next openIndex re-reads the file from disk. */
export function invalidateIndex(path: string): void {
  closeHandle(path);
}

/** Null when the index has not been built yet - callers render an empty state. */
export function openIndex(path: string): DatabaseSync | null {
  const fingerprint = fileFingerprint(path);
  if (!fingerprint) {
    closeHandle(path);
    return null;
  }

  const existing = handles.get(path);
  if (
    existing &&
    existing.mtimeMs === fingerprint.mtimeMs &&
    existing.size === fingerprint.size
  ) {
    return existing.db;
  }

  if (existing) closeHandle(path);
  if (!existsSync(path)) return null;

  try {
    const db = new DatabaseSync(path, { readOnly: true });
    handles.set(path, { db, mtimeMs: fingerprint.mtimeMs, size: fingerprint.size });
    return db;
  } catch (err) {
    console.error(`[workspace-db] could not open ${path}:`, err);
    return null;
  }
}

export function queryIndex<T>(path: string, sql: string, params: unknown[] = []): T[] {
  const db = openIndex(path);
  if (!db) return [];
  try {
    const statement = db.prepare(sql);
    return statement.all(...(params as never[])) as T[];
  } catch (err) {
    console.error(`[workspace-db] query failed on ${path}:`, err);
    // A replaced DB file can leave a stale read-only handle; reopen once.
    closeHandle(path);
    const retry = openIndex(path);
    if (!retry) return [];
    try {
      return retry.prepare(sql).all(...(params as never[])) as T[];
    } catch (retryErr) {
      console.error(`[workspace-db] query retry failed on ${path}:`, retryErr);
      return [];
    }
  }
}

/**
 * Escapes a user string for an FTS5 MATCH. Bare input is a query language -
 * a stray quote or `NEAR` is a syntax error, so every term is quoted and the
 * last one gets a prefix `*` for type-ahead.
 */
export function ftsQuery(input: string): string | null {
  const terms = input
    .split(/\s+/)
    .map((term) => term.replace(/["*]/g, '').trim())
    .filter(Boolean);
  if (!terms.length) return null;
  return terms.map((term, i) => (i === terms.length - 1 ? `"${term}"*` : `"${term}"`)).join(' AND ');
}
