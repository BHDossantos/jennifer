import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';
import { signWebhook } from '../../src/events/events.js';
import { ACCOUNT, grantRoutineReplies, makeHarness } from '../harness.js';

const OWNER = 'owner-token-0123456789';
const DEV = 'developer-token-0123456789';
const SECRET = 'webhook-secret-0123456789';

function setup() {
  const h = makeHarness();
  const app = buildServer(h.j, { tokens: { [OWNER]: 'owner', [DEV]: 'developer' }, webhookSecret: SECRET });
  return { h, app };
}

describe('API (§15)', () => {
  it('requires authentication and separates developer access from correspondence', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/v1/today' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/today', headers: { authorization: `Bearer ${DEV}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/actions', headers: { authorization: `Bearer ${DEV}` } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/connections', headers: { authorization: `Bearer ${DEV}` } })).statusCode).toBe(200);
    const today = await app.inject({ method: 'GET', url: '/v1/today', headers: { authorization: `Bearer ${OWNER}` } });
    expect(today.statusCode).toBe(200);
    expect(today.json().brief.connectorHealth.length).toBeGreaterThan(0);
  });

  it('approves the exact revision shown and executes', async () => {
    const { h, app } = setup();
    const a = h.j.actions.propose({ ownerId: 'bruno', type: 'send_message', space: 'music', channel: 'email', connectorId: 'gmail', accountId: ACCOUNT, payload: h.sendPayload({ to: ['marco@bianchi-music.it'], body: 'hello' }), proposedBy: 'jennifer' });
    const auth = { authorization: `Bearer ${OWNER}` };
    const stale = await app.inject({ method: 'POST', url: `/v1/actions/${a.id}/approve`, headers: auth, payload: { revision: 1, payloadHash: 'nope' } });
    expect(stale.statusCode).toBe(409);
    const ok = await app.inject({ method: 'POST', url: `/v1/actions/${a.id}/approve`, headers: auth, payload: { revision: a.revision, payloadHash: a.payloadHash } });
    expect(ok.json().state).toBe('provider_accepted');
    expect(h.gmail.sent).toHaveLength(1);
  });

  it('webhooks: signature required, duplicate delivery acknowledged once, processed asynchronously', async () => {
    const { h, app } = setup();
    grantRoutineReplies(h);
    const body = JSON.stringify({
      accountId: ACCOUNT,
      providerMessageId: 'wh-1',
      providerThreadId: 'wh-t',
      from: { displayName: 'Marco Bianchi', address: 'marco@bianchi-music.it' },
      subject: 'Thursday',
      body: 'Thursday works?',
      occurredAt: h.clock.now().toISOString(),
      space: 'music',
    });
    const ts = String(Math.floor(h.clock.now().getTime() / 1000));
    const bad = await app.inject({ method: 'POST', url: '/v1/webhooks/email/gmail', headers: { 'content-type': 'application/json', 'x-jennifer-timestamp': ts, 'x-jennifer-signature': '00' }, payload: body });
    expect(bad.statusCode).toBe(401);
    const headers = { 'content-type': 'application/json', 'x-jennifer-timestamp': ts, 'x-jennifer-signature': signWebhook(SECRET, ts, body) };
    const r1 = await app.inject({ method: 'POST', url: '/v1/webhooks/email/gmail', headers, payload: body });
    const r2 = await app.inject({ method: 'POST', url: '/v1/webhooks/email/gmail', headers, payload: body });
    expect(r1.statusCode).toBe(202);
    expect(r2.json().duplicate).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    await h.j.actions.runDue();
    expect(h.gmail.sent).toHaveLength(1);
  });

  it('revoking authority via the API takes effect immediately', async () => {
    const { h, app } = setup();
    const rule = grantRoutineReplies(h);
    const a = h.j.actions.propose({ ownerId: 'bruno', type: 'send_message', space: 'music', channel: 'email', connectorId: 'gmail', accountId: ACCOUNT, payload: h.sendPayload({ to: ['marco@bianchi-music.it'], body: 'x' }), proposedBy: 'jennifer' });
    await app.inject({ method: 'DELETE', url: `/v1/authority/${rule.id}`, headers: { authorization: `Bearer ${OWNER}` } });
    expect(h.j.actions.get(a.id).state).toBe('awaiting_decision');
  });
});
