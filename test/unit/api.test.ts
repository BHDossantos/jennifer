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

describe('dashboard', () => {
  it('ships syntactically valid JavaScript', async () => {
    const { DASHBOARD_HTML } = await import('../../src/api/dashboard.js');
    const { Script } = await import('node:vm');
    const js = DASHBOARD_HTML.split('<script>')[1]!.split('</script>')[0]!;
    expect(() => new Script(js)).not.toThrow();
  });
});

describe('onboarding and today', () => {
  it('lists remaining setup steps and shows today in Rome time', async () => {
    const { h, app } = setup();
    const ob = (await app.inject({ method: 'GET', url: '/v1/onboarding', headers: { authorization: `Bearer ${OWNER}` } })).json();
    expect(ob.steps.find((s: { id: string }) => s.id === 'gmail').done).toBe(true); // harness marks gmail connected
    expect(ob.steps.find((s: { id: string }) => s.id === 'voice').done).toBe(false);
    expect(ob.remaining).toBeGreaterThan(0);
    const ev = h.j.calendar.buildEvent({ calendarId: 'primary', title: 'Studio', start: { date: '2026-10-26', time: '15:00', timeZone: 'Europe/Rome' }, durationMin: 60, attendees: [] });
    await h.j.calendar.provider.upsert(ev);
    expect(h.j.dailyBrief().today).toEqual([{ time: '15:00', title: 'Studio', location: undefined }]);
  });
});

describe('UX endpoints (§14) and learning (§13)', () => {
  const auth = { authorization: `Bearer ${OWNER}` };

  it('conversation detail shows messages with drafts; edit → approve the new version; feedback is captured', async () => {
    const { h, app } = setup();
    await h.j.inbound.handle(h.email({ from: { displayName: 'Marco Bianchi', address: 'marco@bianchi-music.it' }, subject: 'Thursday?', body: 'Can we meet Thursday?' }), { autoDraft: true });
    const list = (await app.inject({ method: 'GET', url: '/v1/conversations', headers: auth })).json();
    expect(list[0]).toMatchObject({ subject: 'Thursday?', pendingActions: 1 });
    const detail = (await app.inject({ method: 'GET', url: `/v1/conversations/${list[0].id}`, headers: auth })).json();
    expect(detail.messages[0].body).toMatch(/Thursday/);
    const draft = detail.actions[0];
    expect(draft.state).toBe('awaiting_decision');

    const full = (await app.inject({ method: 'GET', url: `/v1/actions/${draft.id}`, headers: auth })).json();
    const edited = (await app.inject({ method: 'POST', url: `/v1/actions/${draft.id}/edit`, headers: auth, payload: { payload: { ...full.payloadRaw, body: 'Thursday at 15:00 works. Bruno' } } })).json();
    expect(edited.revision).toBe(2);
    // The old version's approval is refused.
    expect((await app.inject({ method: 'POST', url: `/v1/actions/${draft.id}/approve`, headers: auth, payload: { revision: draft.revision, payloadHash: draft.payloadHash } })).statusCode).toBe(409);
    const ok = (await app.inject({ method: 'POST', url: `/v1/actions/${draft.id}/approve`, headers: auth, payload: { revision: edited.revision, payloadHash: edited.payloadHash } })).json();
    expect(ok.state).toBe('provider_accepted');
    const fb = (await app.inject({ method: 'GET', url: '/v1/feedback', headers: auth })).json();
    expect(fb.feedback[0]).toMatchObject({ kind: 'edited', approvedFinal: 'Thursday at 15:00 works. Bruno' });
  });

  it('declining with a reason is learned; repeated tone corrections become a style rule Bruno can drop', async () => {
    const { h, app } = setup();
    for (let n = 0; n < 3; n++) {
      const a = h.j.actions.propose({ ownerId: 'bruno', type: 'send_message', space: 'music', channel: 'email', connectorId: 'gmail', accountId: ACCOUNT, payload: h.sendPayload({ to: ['unknown@else.test'], body: `Hey!!! ${n}` }), proposedBy: 'jennifer' });
      expect(a.state).toBe('awaiting_decision');
      await app.inject({ method: 'POST', url: `/v1/actions/${a.id}/cancel`, headers: auth, payload: { reason: 'poor_tone', note: 'too casual' } });
    }
    const fb = (await app.inject({ method: 'GET', url: '/v1/feedback', headers: auth })).json();
    expect(fb.feedback.filter((f: { kind: string }) => f.kind === 'poor_tone')).toHaveLength(3);
    expect(fb.rules[0]).toMatchObject({ impact: 'style', status: 'auto_applied' });
    const dropped = (await app.inject({ method: 'POST', url: `/v1/feedback/rules/${encodeURIComponent(fb.rules[0].id)}`, headers: auth, payload: { status: 'rejected' } })).json();
    expect(dropped.status).toBe('rejected');
  });

  it('dead letters: retry creates a fresh proposal that waits for Bruno; memory can be corrected and exported', async () => {
    const { h, app } = setup();
    const a = h.j.actions.propose({ ownerId: 'bruno', type: 'send_message', space: 'music', channel: 'email', connectorId: 'gmail', accountId: ACCOUNT, payload: h.sendPayload({ to: ['marco@bianchi-music.it'], body: 'hello' }), proposedBy: 'jennifer' });
    h.j.actions.cancel(a.id, 'system', 'test');
    const d = h.j.deadLetters.push({ subjectId: a.id, kind: 'send_failed', error: 'SMTP 550', attempts: 3, recoveryAction: 'Check the address and try again' });
    const retry = (await app.inject({ method: 'POST', url: `/v1/dead-letters/${d.id}/retry`, headers: auth })).json();
    expect(retry.state).toBe('awaiting_decision');
    expect(h.j.deadLetters.list()).toHaveLength(0);

    const m = h.j.memory.add({ ownerId: 'bruno', kind: 'profile_fact', space: 'personal', value: 'Dentist is Dr. Rossi', source: { kind: 'bruno_statement', ref: 't', excerpt: 'x', assertedBy: 'bruno' }, confidence: 'confirmed', sensitivity: 'normal', retention: 'indefinite' });
    const fixed = (await app.inject({ method: 'POST', url: `/v1/memory/${m.id}/correct`, headers: auth, payload: { value: 'Dentist is Dr. Verdi' } })).json();
    expect(fixed.value).toBe('Dentist is Dr. Verdi');
    const exp = (await app.inject({ method: 'GET', url: '/v1/memory/export', headers: auth })).json();
    expect(exp.entries.some((e: { value: string }) => e.value === 'Dentist is Dr. Verdi')).toBe(true);
  });
});
