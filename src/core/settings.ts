import type { Db } from '../db/db.js';

/** Small owner-settings store: in-memory by default, Postgres when durable. */
export interface SettingsStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export class MemorySettings implements SettingsStore {
  private m = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.m.get(key) as T | undefined;
  }
  async set<T>(key: string, value: T) {
    this.m.set(key, structuredClone(value));
  }
}

export class PgSettings implements SettingsStore {
  constructor(
    private db: Db,
    private ownerId: string,
  ) {}
  async get<T>(key: string) {
    const r = await this.db.query<{ value: T }>('SELECT value FROM app_setting WHERE owner_id = $1 AND key = $2', [this.ownerId, key]);
    return r.rows[0]?.value;
  }
  async set<T>(key: string, value: T) {
    await this.db.query(
      `INSERT INTO app_setting (owner_id, key, value, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [this.ownerId, key, JSON.stringify(value)],
    );
  }
}
