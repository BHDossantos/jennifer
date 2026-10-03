import { describe, expect, it } from 'vitest';
import { createDurableJennifer } from '../../src/app.js';
import { buildServer } from '../../src/api/server.js';
import { pgliteDb } from '../../src/db/db.js';
import { FakeClock } from '../../src/core/util.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { IdentityService } from '../../src/identity/identity.js';
import type { ActionHandler } from '../../src/actions/model.js';
import { SoftAuthenticator } from '../softAuthenticator.js';

const RP = { rpId: 'jennifer.test', rpName: 'Jennifer', origins: ['https://jennifer.test'] };
const BOOTSTRAP = 'bootstrap-owner-token-0123456789';

/** Stand-in handler for a high-risk action type (contract signature). */
const signContract: ActionHandler = {
  type: 'sign_contract',
  resolve: (i) => ({
    authority: { action: 'sign_contract', accountId: i.accountId, space: i.space, contactIds: [], recipientDomains: [], attachmentSpaces: [], recipientCount: 0 },
    contactIds: [],
    addresses: [],
    violations: [],
    concerns: [],
  }),
  perform: async () => ({ kind: 'accepted', receipt: { deliveryStatus: 'confirmed', evidence: 'test e-sign provider' } }),
  reconcile: async () => ({ found: false }),
};

describe('Week 2 — authenticated API with passkeys', () => {
  it('passkey sign-in over HTTP; high-risk approval needs a fresh step-up, never a body flag', async () => {
    const db = await pgliteDb();
    const clock = new FakeClock('2026-10-03T08:00:00Z');
    const j = await createDurableJennifer({ db, clock, emailConnectors: [new FakeEmailProvider()], config: { ownerId: 'bruno' } });
    j.actions.register(signContract);
    const identity = new IdentityService(db, clock, j.audit, RP);
    const app = buildServer(j, { tokens: { [BOOTSTRAP]: 'owner' }, identity });
    const phone = new SoftAuthenticator(RP.rpId, RP.origins[0]!);
    const boot = { authorization: `Bearer ${BOOTSTRAP}` };

    const regOpts = (await app.inject({ method: 'POST', url: '/v1/auth/passkeys/register/options', headers: boot })).json();
    const reg = await app.inject({ method: 'POST', url: '/v1/auth/passkeys/register/verify', headers: boot, payload: { handle: regOpts.handle, response: phone.register(regOpts.options), device: { platform: 'iOS', label: 'iPhone 17 Pro Max' } } });
    expect(reg.statusCode).toBe(200);

    const loginOpts = (await app.inject({ method: 'POST', url: '/v1/auth/passkeys/login/options' })).json();
    const login = await app.inject({ method: 'POST', url: '/v1/auth/passkeys/login/verify', payload: { handle: loginOpts.handle, response: phone.assert(loginOpts.options) } });
    const { token } = login.json();
    const session = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/v1/today', headers: session })).statusCode).toBe(200);

    const sign = () =>
      j.actions.propose({ ownerId: 'bruno', type: 'sign_contract', space: 'insurance', channel: 'app', connectorId: 'esign', accountId: 'esign:bruno', payload: { contract: 'carrier-appointment.pdf' }, proposedBy: 'jennifer' });

    // Static bootstrap token cannot step up, even if the body claims it.
    const a = sign();
    const viaToken = await app.inject({ method: 'POST', url: `/v1/actions/${a.id}/approve`, headers: boot, payload: { revision: a.revision, payloadHash: a.payloadHash, stepUpVerified: true } });
    expect(viaToken.json().error).toBe('approval.step_up_required');

    // Fresh passkey session (login counts as step-up) succeeds.
    const ok = await app.inject({ method: 'POST', url: `/v1/actions/${a.id}/approve`, headers: session, payload: { revision: a.revision, payloadHash: a.payloadHash } });
    expect(ok.json().state).toBe('provider_accepted');

    // Six minutes later a new high-risk approval needs another step-up.
    clock.advance(6 * 60_000);
    const b = sign();
    const stale = await app.inject({ method: 'POST', url: `/v1/actions/${b.id}/approve`, headers: session, payload: { revision: b.revision, payloadHash: b.payloadHash } });
    expect(stale.json().error).toBe('approval.step_up_required');
    const suOpts = (await app.inject({ method: 'POST', url: '/v1/auth/step-up/options', headers: session })).json();
    expect((await app.inject({ method: 'POST', url: '/v1/auth/step-up/verify', headers: session, payload: { handle: suOpts.handle, response: phone.assert(suOpts.options) } })).statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: `/v1/actions/${b.id}/approve`, headers: session, payload: { revision: b.revision, payloadHash: b.payloadHash } });
    expect(again.json().state).toBe('provider_accepted');

    // Lost phone: revoke the device; its session stops working.
    await app.inject({ method: 'DELETE', url: `/v1/devices/${reg.json().deviceId}`, headers: boot });
    expect((await app.inject({ method: 'GET', url: '/v1/today', headers: session })).statusCode).toBe(401);
    await j.store.flush();
    await db.close();
  });
});
