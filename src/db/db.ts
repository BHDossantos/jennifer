/**
 * Minimal database port. Production uses node-postgres against Cloud SQL;
 * tests and the simulator use PGlite (real Postgres compiled to WASM, with
 * pgvector), so SQL is exercised exactly as in production.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function pgDb(connectionString: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 10 });
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }): Omit<Db, 'transaction' | 'close'> => ({
    query: async (sql, params) => ({ rows: (await c.query(sql, params as unknown[])).rows }),
    exec: async (sql) => {
      await c.query(sql);
    },
  });
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: Db = { ...wrap(client), transaction: (f) => f(tx), close: async () => {} };
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** In-process Postgres for tests, the simulator and local development without Docker. */
export async function pgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const options = { extensions: { vector, pgcrypto } };
  const db = dataDir ? new PGlite(dataDir, options) : new PGlite(options);
  let depth = 0;
  const self: Db = {
    query: async (sql, params) => ({ rows: (await db.query(sql, params as unknown[])).rows as never[] }),
    exec: async (sql) => {
      await db.exec(sql);
    },
    async transaction(fn) {
      if (depth > 0) return fn(self);
      depth++;
      try {
        return await db.transaction(async (tx) => {
          const txDb: Db = {
            query: async (sql, params) => ({ rows: (await tx.query(sql, params as unknown[])).rows as never[] }),
            exec: async (sql) => {
              await tx.exec(sql);
            },
            transaction: (f) => f(txDb),
            close: async () => {},
          };
          return fn(txDb);
        });
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
  return self;
}
