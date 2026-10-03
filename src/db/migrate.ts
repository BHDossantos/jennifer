import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../core/util.js';
import type { Db } from './db.js';

/**
 * Reviewed, ordered migrations (spec §3). Applied files are checksummed; an
 * already-applied migration that changed on disk stops the deploy instead of
 * silently drifting.
 */
export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(db: Db, dir = 'db/migrations'): Promise<MigrationResult> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const applied = new Map((await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
  const out: MigrationResult = { applied: [], skipped: [] };
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const sum = sha256(sql);
    const prior = applied.get(f);
    if (prior) {
      if (prior !== sum) throw new Error(`Migration ${f} changed after it was applied; write a new migration instead`);
      out.skipped.push(f);
      continue;
    }
    // Files manage their own BEGIN/COMMIT; strip them so the runner owns the transaction.
    const body = sql.replace(/^\s*BEGIN;\s*$/im, '').replace(/^\s*COMMIT;\s*$/im, '');
    await db.transaction(async (tx) => {
      await tx.exec(body);
      await tx.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f, sum]);
    });
    out.applied.push(f);
  }
  return out;
}
