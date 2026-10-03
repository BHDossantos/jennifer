import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { pgliteDb, type Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { ensureOwner } from '../../src/db/pgStore.js';
import { FakeClock } from '../../src/core/util.js';
import { AuditLog } from '../../src/audit/audit.js';
import { IdentityService } from '../../src/identity/identity.js';
import { LocalKeyWrapper, Vault } from '../../src/identity/vault.js';
import { SoftAuthenticator } from '../softAuthenticator.js';

const RP = { rpId: 'jennifer.test', rpName: 'Jennifer', origins: ['https://jennifer.test'] };

async function setup() {
  const db = await pgliteDb();
  await migrate(db);
  await ensureOwner(db, 'bruno');
  const clock = new FakeClock('2026-10-03T08:00:00Z');
  const audit = new AuditLog(clock);
  return { db, clock, audit, id: new IdentityService(db, clock, audit, RP) };
}

async function enroll(id: IdentityService, auth: SoftAuthenticator) {
  const reg = await id.registrationOptions('bruno', 'bruno');
  return id.verifyRegistration(reg.handle, auth.register(reg.options) as never, { platform: 'iOS', label: 'iPhone 17 Pro Max' });
}

async function login(id: IdentityService, auth: SoftAuthenticator) {
  const o = await id.loginOptions('bruno');
  return id.verifyLogin(o.handle, auth.assert(o.options) as never);
}

describe('Week 2 — identity (passkeys, sessions, devices)', () => {
  it('registers a passkey, signs in, and authenticates the session', async () => {
    const { id, db } = await setup();
    const phone = new SoftAuthenticator(RP.rpId, RP.origins[0]!);
    const { deviceId } = await enroll(id, phone);
    const { token } = await login(id, phone);
    const s = await id.authenticate(token);
    expect(s).toMatchObject({ ownerId: 'bruno', deviceId, role: 'owner' });
    const stored = await db.query<{ id_hash: string }>('SELECT id_hash FROM auth_session');
    expect(stored.rows[0]!.id_hash).not.toBe(token); // only the hash is stored
    await db.close();
  });

  it('rejects wrong origin, replayed challenges and unknown credentials', async () => {
    const { id, db } = await setup();
    const phone = new SoftAuthenticator(RP.rpId, RP.origins[0]!);
    await enroll(id, phone);
    const o = await id.loginOptions('bruno');
    await expect(id.verifyLogin(o.handle, phone.assert(o.options, 'https://evil.test') as never)).rejects.toThrow();
    await expect(id.verifyLogin(o.handle, phone.assert(o.options) as never)).rejects.toThrow(/expired or already used/);
    const stranger = new SoftAuthenticator(RP.rpId, RP.origins[0]!);
    const o2 = await id.loginOptions('bruno');
    await expect(id.verifyLogin(o2.handle, stranger.assert(o2.options) as never)).rejects.toThrow(/Unknown or revoked/);
    await db.close();
  });

  it('step-up is fresh for five minutes and bound to the session device', async () => {
    const { id, db, clock } = await setup();
    const phone = new SoftAuthenticator(RP.rpId, RP.origins[0]!);
    await enroll(id, phone);
    const { token } = await login(id, phone);
    let s = (await id.authenticate(token))!;
    expect(id.hasRecentStepUp(s)).toBe(true);
    clock.advance(6 * 60_000);
    s = (await id.authenticate(token))!;
    expect(id.hasRecentStepUp(s)).toBe(false);
    const o = await id.stepUpOptions(s);
    await id.verifyStepUp(s, o.handle, phone.assert(o.options) as never);
    s = (await id.authenticate(token))!;
    expect(id.hasRecentStepUp(s)).toBe(true);
    await db.close();
  });

  it('revoking a lost phone kills its sessions and passkeys; sessions expire', async () => {
    const { id, db, clock } = await setup();
    const phone = new SoftAuthenticator(RP.rpId, RP.origins[0]!);
    const laptop = new SoftAuthenticator(RP.rpId, RP.origins[0]!);
    const { deviceId } = await enroll(id, phone);
    await enroll(id, laptop);
    const { token } = await login(id, phone);
    const { token: laptopToken } = await login(id, laptop);
    await id.revokeDevice('bruno', deviceId, 'bruno');
    expect(await id.authenticate(token)).toBeUndefined();
    expect(await id.authenticate(laptopToken)).toBeDefined();
    const o = await id.loginOptions('bruno');
    await expect(id.verifyLogin(o.handle, phone.assert(o.options) as never)).rejects.toThrow(/revoked/);
    clock.advance(13 * 3600_000);
    expect(await id.authenticate(laptopToken)).toBeUndefined();
    await db.close();
  });
});

describe('Week 2 — vault', () => {
  async function vault(db: Db, keys: Map<number, Buffer>) {
    return new Vault(db, new LocalKeyWrapper(keys));
  }
  const binding = { ownerId: 'bruno', accountId: 'gmail:bruno', environment: 'production' };

  it('round-trips, never stores plaintext, and fails closed on the wrong binding', async () => {
    const { db } = await setup();
    const v = await vault(db, new Map([[1, randomBytes(32)]]));
    await v.put('gmail.refresh', '1//refresh-token-value', binding);
    expect(await v.get('gmail.refresh', binding)).toBe('1//refresh-token-value');
    const raw = await db.query<Record<string, unknown>>('SELECT * FROM vault_secret');
    expect(JSON.stringify(raw.rows)).not.toContain('refresh-token-value');
    await expect(v.get('gmail.refresh', { ...binding, environment: 'staging' })).rejects.toThrow(/cannot be opened/);
    await expect(v.get('gmail.refresh', { ...binding, accountId: 'gmail:other' })).rejects.toThrow(/cannot be opened/);
    await v.revoke('gmail.refresh');
    await expect(v.get('gmail.refresh', binding)).rejects.toThrow(/revoked/);
    await db.close();
  });

  it('rotates master keys without losing secrets', async () => {
    const { db } = await setup();
    const k1 = randomBytes(32);
    const v1 = await vault(db, new Map([[1, k1]]));
    await v1.put('openai', 'sk-test-abcdefghijklmnopqrstuvwxyz', binding);
    const v2 = await vault(db, new Map([[1, k1], [2, randomBytes(32)]]));
    expect(await v2.rotate()).toBe(1);
    const row = await db.query<{ key_version: number }>('SELECT key_version FROM vault_secret');
    expect(row.rows[0]!.key_version).toBe(2);
    expect(await v2.get('openai', binding)).toBe('sk-test-abcdefghijklmnopqrstuvwxyz');
    await db.close();
  });
});
