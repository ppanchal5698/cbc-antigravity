/** Gateway-side database access: the shared pool plus one-time schema setup. */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query as rawQuery, withTransaction } from '../lib/db.ts';
import type { QueryResultRow } from 'pg';

export { pool, withTransaction };

const here = dirname(fileURLToPath(import.meta.url));

let ready: Promise<void> | undefined;

/** Applies schema.sql once per process. The gateway owns schema setup. */
export function initDb(): Promise<void> {
  ready ??= (async () => {
    const sql = await readFile(join(here, 'schema.sql'), 'utf8');
    await pool.query(sql);
  })();
  return ready;
}

export async function query<T extends QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  await initDb();
  return rawQuery<T>(text, params);
}
