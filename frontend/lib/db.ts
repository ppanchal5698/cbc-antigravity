/** Shared Postgres pool. Used by both the Next.js routes and the gateway. */
import pg from 'pg';

const globalForPg = globalThis as unknown as { cbcPool?: pg.Pool };

export const pool: pg.Pool =
  globalForPg.cbcPool ??
  new pg.Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://cbc:cbc@localhost:5432/cbc',
    max: Number(process.env.PGPOOL_MAX || 10),
  });

// Next.js dev reloads modules; without this each reload leaks a pool.
globalForPg.cbcPool ??= pool;

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export async function query<T extends pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

/** Runs `fn` in a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
