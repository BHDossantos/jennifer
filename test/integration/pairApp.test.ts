import { describe, expect, it, vi } from 'vitest';
import { createDurableJennifer } from '../../src/app.js';
import { buildServer } from '../../src/api/server.js';
import { pgliteDb } from '../../src/db/db.js';
import { FakeClock } from '../../src/core/util.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { IdentityService } from '../../src/identity/identity.js';
import { SoftAuthenticator } from '../softAuthenticator.js';

const RP = { rpId: 'jennifer.test', rpName: 'Jennifer', origins: ['https://jennifer.test'] };
const BOOTSTRAP = 'bootstrap-owner-token-0123456789';

describe('pairing the TestFlight iPhone app with a one-time code', () => {
  it('needs a passkey session, works once, gives the app its own revocable session, and locks after repeated wrong codes', async () => {
    const db = await pgliteDb();
    const clock = new FakeClock('2026-10-09T08:00:00Z');
    const j = await createDurableJennifer({ db, clock, emailConnectors: [new FakeEmailProvider()], config: { ownerId: 'bruno' } });
    const identity = new IdentityService(db, clock, j.audit, RP);
    const app = buildServer(j, { tokens: { [BOOTSTRAP]: 'owner' }, identity });
    const phone = new SoftAuthenticator(RP.rpId, RP.origins[0]!);
    const boot = { authorization: `Bearer ${BOOTSTRAP}` };
    const regOpts = (await app.inject({ method: 'POST', url: '/v1/auth/passkeys/register/options', headers: boot })).json();
    await app.inject({ method: 'POST', url: '/v1/auth/passkeys/register/verify', headers: boot, payload: { handle: regOpts.handle, response: phone.register(regOpts.options), device: { platform: 'web' } } });
    const loginOpts = (await app.inject({ method: 'POST', url: '/v1/auth/passkeys/login/options' })).json();
    const { token } = (await app.inject({ method: 'POST', url: '/v1/auth/passkeys/login/verify', payload: { handle: loginOpts.handle, response: phone.assert(loginOpts.options) } })).json();
    const web = { authorization: `Bearer ${token}` };

    // The static bootstrap token cannot mint app sessions.
    expect((await app.inject({ method: 'POST', url: '/v1/auth/pair/start', headers: boot, payload: {} })).statusCode).toBeGreaterThanOrEqual(400);
    const start = (await app.inject({ method: 'POST', url: '/v1/auth/pair/start', headers: web, payload: {} })).json();
    expect(start.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const finish = (code: string) => app.inject({ method: 'POST', url: '/v1/auth/pair/finish', payload: { code, platform: 'ios', label: 'Jennifer iPhone app' } });
    expect((await finish('WRNG-CODE')).statusCode).toBe(401);
    const ok = await finish(start.code.toLowerCase().replace('-', ' '));
    expect(ok.statusCode).toBe(200);
    const appSession = { authorization: `Bearer ${ok.json().token}` };
    expect((await app.inject({ method: 'GET', url: '/v1/today', headers: appSession })).statusCode).toBe(200);
    expect((await finish(start.code)).statusCode).toBe(401); // single use

    // The app session cannot do sensitive things without a passkey step-up.
    expect((await app.inject({ method: 'POST', url: '/v1/auth/pair/start', headers: appSession, payload: {} })).json().error).toBe('approval.step_up_required');

    // Native registration is bound to the authenticated device, never a caller-supplied ID.
    const push = { token: 'ExpoPushToken[test-device]' };
    expect((await app.inject({ method: 'POST', url: '/v1/push/native/subscribe', headers: boot, payload: push })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: 'POST', url: '/v1/push/native/subscribe', headers: appSession, payload: { token: 'invalid' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/push/native/subscribe', headers: appSession, payload: push })).statusCode).toBe(200);
    expect((await j.notifications.nativeSubscriptions())[0]?.deviceId).toBe(ok.json().deviceId);
    expect((await app.inject({ method: 'POST', url: '/v1/push/native/unsubscribe', headers: appSession })).statusCode).toBe(200);
    expect(await j.notifications.nativeSubscriptions()).toEqual([]);
    await app.inject({ method: 'POST', url: '/v1/push/native/subscribe', headers: appSession, payload: push });

    // Revoking the app's device ends its session and clears native registration.
    expect((await app.inject({ method: 'DELETE', url: `/v1/devices/${ok.json().deviceId}`, headers: boot })).statusCode).toBe(200);
    expect(await j.notifications.nativeSubscriptions()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/today', headers: appSession })).statusCode).toBe(401);

    // Guessing is capped.
    for (let i = 0; i < 9; i++) await finish('AAAA-AAAA');
    expect((await finish('AAAA-AAAA')).statusCode).toBe(429);
    await db.close();
  });
});


describe('native app logout', () => {
  it.each([false, true])('revokes the session before push cleanup (cleanup fails: %s)', async (cleanupFails) => {
    const db = await pgliteDb();
    const clock = new FakeClock('2026-11-02T12:00:00Z');
    const j = await createDurableJennifer({ db, clock, config: { ownerId: 'bruno' } });
    const identity = new IdentityService(db, clock, j.audit, RP);
    const app = buildServer(j, { identity, tokens: {} });
    try {
      const phone = new SoftAuthenticator(RP.rpId, RP.origins[0]!);
      const options = await identity.registrationOptions('bruno', 'bruno');
      const enrolled = await identity.verifyRegistration(options.handle, phone.register(options.options) as never, { platform: 'web' });
      const { token } = await identity.pairDevice('bruno', { platform: 'ios' }, enrolled.deviceId);
      const headers = { authorization: `Bearer ${token}` };
      expect((await app.inject({ method: 'POST', url: '/v1/push/native/subscribe', headers, payload: { token: 'ExpoPushToken[logout-test]' } })).statusCode).toBe(200);
      const originalCleanup = j.notifications.unsubscribeNative.bind(j.notifications);
      let alreadyRevoked = false;
      const cleanup = vi.spyOn(j.notifications, 'unsubscribeNative').mockImplementation(async deviceId => {
        alreadyRevoked = (await identity.authenticate(token)) === undefined;
        if (cleanupFails) throw new Error('Simulated notification storage failure');
        await originalCleanup(deviceId);
      });
      const response = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(alreadyRevoked).toBe(true);
      expect(await identity.authenticate(token)).toBeUndefined();
      expect((await app.inject({ method: 'GET', url: '/v1/today', headers })).statusCode).toBe(401);
      if (!cleanupFails) expect(await j.notifications.nativeSubscriptions()).toEqual([]);
    } finally {
      await app.close();
      await db.close();
    }
  });
});
