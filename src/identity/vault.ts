import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { JenniferError } from '../core/types.js';
import type { Db } from '../db/db.js';

/**
 * Secret vault for provider refresh tokens and API credentials (spec §4).
 *
 * Envelope encryption: each secret has its own random data key; the data key
 * is wrapped by a master key held in KMS (production) or an env-provided key
 * (development). The binding (owner, account, environment, ref) is the AES-GCM
 * additional data, so a token can only be decrypted for the account and
 * environment it was issued to. Plaintext never touches the database, logs,
 * prompts or client bundles.
 */
export interface SecretBinding {
  ownerId: string;
  accountId: string;
  environment: string;
}

export interface KeyWrapper {
  readonly currentVersion: number;
  wrap(dataKey: Buffer, aad: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer, version: number, aad: Buffer): Promise<Buffer>;
}

/** Local master keys (32 bytes each), keyed by version for rotation. Development and tests. */
export class LocalKeyWrapper implements KeyWrapper {
  constructor(private keys: Map<number, Buffer>) {
    for (const [v, k] of keys) if (k.length !== 32) throw new Error(`Master key v${v} must be 32 bytes`);
  }

  static fromEnv(value: string | undefined): LocalKeyWrapper {
    if (!value) throw new Error('JENNIFER_VAULT_KEYS is required (format: "1:<base64 32 bytes>,2:<...>")');
    const map = new Map<number, Buffer>();
    // A single high-entropy secret (e.g. a platform-generated value) is accepted as key v1 via SHA-256.
    if (!value.includes(':')) {
      if (value.length < 32) throw new Error('JENNIFER_VAULT_KEYS secret is too short');
      map.set(1, createHash('sha256').update(value).digest());
      return new LocalKeyWrapper(map);
    }
    for (const part of value.split(',')) {
      const [v, b64] = part.split(':');
      map.set(Number(v), Buffer.from(b64 ?? '', 'base64'));
    }
    return new LocalKeyWrapper(map);
  }

  get currentVersion(): number {
    return Math.max(...this.keys.keys());
  }

  async wrap(dataKey: Buffer, aad: Buffer): Promise<Buffer> {
    const { iv, ct, tag } = seal(this.key(this.currentVersion), dataKey, aad);
    return Buffer.concat([iv, tag, ct]);
  }

  async unwrap(wrapped: Buffer, version: number, aad: Buffer): Promise<Buffer> {
    return open(this.key(version), wrapped.subarray(0, 12), wrapped.subarray(28), wrapped.subarray(12, 28), aad);
  }

  private key(v: number): Buffer {
    const k = this.keys.get(v);
    if (!k) throw new JenniferError('vault.unknown_key_version', `Master key version ${v} is not loaded`);
    return k;
  }
}

/**
 * Google Cloud KMS wrapper (production). Uses the KMS REST API with an
 * access-token provider (workload identity on Cloud Run).
 */
export class GcpKmsKeyWrapper implements KeyWrapper {
  readonly currentVersion = 1; // KMS tracks key versions internally; ciphertext embeds it.
  constructor(
    private keyName: string, // projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>
    private token: () => Promise<string>,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async wrap(dataKey: Buffer, aad: Buffer): Promise<Buffer> {
    const r = await this.call('encrypt', { plaintext: dataKey.toString('base64'), additionalAuthenticatedData: aad.toString('base64') });
    return Buffer.from(r.ciphertext as string, 'base64');
  }

  async unwrap(wrapped: Buffer, _version: number, aad: Buffer): Promise<Buffer> {
    const r = await this.call('decrypt', { ciphertext: wrapped.toString('base64'), additionalAuthenticatedData: aad.toString('base64') });
    return Buffer.from(r.plaintext as string, 'base64');
  }

  private async call(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`https://cloudkms.googleapis.com/v1/${this.keyName}:${op}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new JenniferError('vault.kms_error', `KMS ${op} failed with ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}

function seal(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}

function open(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new JenniferError('vault.binding_mismatch', 'Secret cannot be opened for this account or environment');
  }
}

function aadFor(ref: string, b: SecretBinding): Buffer {
  return Buffer.from(`jennifer-vault|${b.ownerId}|${b.accountId}|${b.environment}|${ref}`);
}

export class Vault {
  constructor(
    private db: Db,
    private wrapper: KeyWrapper,
  ) {}

  async put(ref: string, secret: string, b: SecretBinding): Promise<void> {
    const dataKey = randomBytes(32);
    const aad = aadFor(ref, b);
    const { iv, ct, tag } = seal(dataKey, Buffer.from(secret, 'utf8'), aad);
    const wrapped = await this.wrapper.wrap(dataKey, aad);
    dataKey.fill(0);
    await this.db.query(
      `INSERT INTO vault_secret (ref, owner_id, account_id, environment, wrapped_key, ciphertext, iv, tag, key_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (ref) DO UPDATE SET owner_id = EXCLUDED.owner_id, account_id = EXCLUDED.account_id, environment = EXCLUDED.environment,
         wrapped_key = EXCLUDED.wrapped_key, ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
         key_version = EXCLUDED.key_version, rotated_at = now(), revoked_at = NULL`,
      [ref, b.ownerId, b.accountId, b.environment, wrapped, ct, iv, tag, this.wrapper.currentVersion],
    );
  }

  /** Server-side only. Callers pass the binding they expect; a mismatch fails closed. */
  async get(ref: string, b: SecretBinding): Promise<string> {
    const r = await this.db.query<Record<string, any>>('SELECT * FROM vault_secret WHERE ref = $1', [ref]);
    const row = r.rows[0];
    if (!row) throw new JenniferError('vault.not_found', `No secret ${ref}`);
    if (row.revoked_at) throw new JenniferError('vault.revoked', `Secret ${ref} was revoked`);
    const aad = aadFor(ref, b);
    let dataKey: Buffer;
    try {
      dataKey = await this.wrapper.unwrap(Buffer.from(row.wrapped_key), row.key_version, aad);
    } catch (e) {
      if (e instanceof JenniferError && e.code === 'vault.unknown_key_version') throw e;
      throw new JenniferError('vault.binding_mismatch', 'Secret cannot be opened for this account or environment');
    }
    const plain = open(dataKey, Buffer.from(row.iv), Buffer.from(row.ciphertext), Buffer.from(row.tag), aad);
    dataKey.fill(0);
    return plain.toString('utf8');
  }

  async revoke(ref: string): Promise<void> {
    await this.db.query('UPDATE vault_secret SET revoked_at = now() WHERE ref = $1', [ref]);
  }

  /** Re-wrap every data key with the current master key version (key rotation). */
  async rotate(): Promise<number> {
    const rows = (await this.db.query<Record<string, any>>('SELECT * FROM vault_secret WHERE key_version <> $1 AND revoked_at IS NULL', [this.wrapper.currentVersion])).rows;
    for (const row of rows) {
      const aad = aadFor(row.ref, { ownerId: row.owner_id, accountId: row.account_id, environment: row.environment });
      const dataKey = await this.wrapper.unwrap(Buffer.from(row.wrapped_key), row.key_version, aad);
      const wrapped = await this.wrapper.wrap(dataKey, aad);
      dataKey.fill(0);
      await this.db.query('UPDATE vault_secret SET wrapped_key = $1, key_version = $2, rotated_at = now() WHERE ref = $3', [wrapped, this.wrapper.currentVersion, row.ref]);
    }
    return rows.length;
  }
}
