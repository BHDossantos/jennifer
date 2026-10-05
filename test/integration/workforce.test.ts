import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createJennifer } from '../../src/app.js';
import { FakeClock } from '../../src/core/util.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { buildServer } from '../../src/api/server.js';
import { normalizePhone } from '../../src/connectors/workforce.js';

const WF = 'https://workforce.test';
const SECRET = 'workforce-webhook-secret-123';
const OWNER = { authorization: 'Bearer owner-token-0123456789' };
const jwt = (role: string) => `h.${Buffer.from(JSON.stringify({ sub: 'jennifer@bruno.test', role })).toString('base64url')}.s`;

function setup(opts: { role?: string; expireFirst?: boolean } = {}) {
  const calls: Array<{ method: string; url: string; auth?: string; body?: string }> = [];
  let logins = 0;
  let expired = !!opts.expireFirst;
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const auth = (init.headers as Record<string, string> | undefined)?.authorization;
    calls.push({ method, url, auth, body: typeof init.body === 'string' ? init.body : undefined });
    const u = new URL(url);
    if (u.pathname === '/auth/token') {
      logins++;
      const p = new URLSearchParams(String(init.body));
      if (p.get('password') !== 'pw') return new Response('{"detail":"Incorrect"}', { status: 401 });
      return new Response(JSON.stringify({ access_token: jwt(opts.role ?? 'viewer'), token_type: 'bearer' }), { status: 200 });
    }
    if (expired) {
      expired = false;
      return new Response('{}', { status: 401 });
    }
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    switch (u.pathname) {
      case '/brief/today': return json({ greeting: 'Good morning', top_actions: [{ title: 'Call back Acme' }], summary: '3 actions' });
      case '/dashboard/summary': return json({ insurance_leads: 12, replies: 2 });
      case '/approvals': return json({ count: 4, items: [{ type: 'reply', title: 'Reply to Acme' }], auto_sending: false });
      case '/decisions': return json([{ id: 'd1', title: 'Raise ad spend', status: 'pending' }]);
      case '/crm': return json([{ id: 'lead:1', name: 'Marco Bianchi', company: 'Acme', q: u.searchParams.get('q') }]);
      case '/businesses': return json({ businesses: [{ key: 'insurance', label: 'Thrust Insurance' }, { key: 'savorymind', label: 'SavoryMind' }], count: 2 });
      case '/compliance/dnc': return json({ entries: [{ kind: 'email', value: 'Stop@Example.com', reason: 'asked' }, { kind: 'phone', value: '(305) 555-0100' }, { kind: 'email', value: 'not-an-email' }] });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  const j = createJennifer({
    clock: new FakeClock('2026-10-05T10:00:00Z'),
    emailConnectors: [new FakeEmailProvider()],
    fetchImpl,
    inventoryPath: null as never,
    config: { publicUrl: 'https://jennifer-test.onrender.com', workforce: { url: WF, email: 'jennifer@bruno.test', password: 'pw', webhookSecret: SECRET } } as never,
  });
  const notices: Array<{ title: string; body: string }> = [];
  const notify = j.notifications.notify.bind(j.notifications);
  j.notifications.notify = async (n) => (notices.push(n), notify(n));
  const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
  return { j, app, calls, notices, logins: () => logins };
}

const ctx = { ownerId: 'bruno', role: 'chat', allowedTools: new Set(['workforce_overview', 'workforce_search_crm', 'workforce_pending']), scopes: new Set(['workforce:read']) };

describe('Bruno AI Workforce (read-only)', () => {
  it('signs in once as a viewer, only ever GETs, and answers Jennifer’s questions', async () => {
    const { j, calls, logins } = setup();
    expect(j.capabilities.get('workforce')!.connected).toBe(true);
    const o = (await j.tools.invoke('workforce_overview', {}, ctx)) as { brief: { summary: string }; approvalsWaitingInWorkforce: number };
    expect(o.brief.summary).toBe('3 actions');
    expect(o.approvalsWaitingInWorkforce).toBe(4);
    const crm = (await j.tools.invoke('workforce_search_crm', { query: 'Bianchi' }, ctx)) as Array<{ name: string; q: string }>;
    expect(crm[0]).toMatchObject({ name: 'Marco Bianchi', q: 'Bianchi' });
    const pending = (await j.tools.invoke('workforce_pending', { include: 'both' }, ctx)) as { approvals: { count: number }; decisions: unknown[] };
    expect(pending.approvals.count).toBe(4);
    expect(pending.decisions).toHaveLength(1);
    expect(logins()).toBe(1);
    expect(calls.filter((c) => c.method !== 'GET').map((c) => new URL(c.url).pathname)).toEqual(['/auth/token']);
    expect(calls.filter((c) => c.method === 'GET').every((c) => c.auth === `Bearer ${jwt('viewer')}`)).toBe(true);
  });

  it('signs in again when the token expires', async () => {
    const { j, logins } = setup({ expireFirst: true });
    await j.tools.invoke('workforce_search_crm', { query: 'x' }, ctx);
    expect(logins()).toBe(2);
  });

  it('warns when the account is not a viewer, and lists Workforce businesses', async () => {
    const { app } = setup({ role: 'admin' });
    const s = (await app.inject({ method: 'GET', url: '/v1/connectors/workforce', headers: OWNER })).json();
    expect(s).toMatchObject({ configured: true, role: 'admin', readOnly: false, webhookUrl: 'https://jennifer-test.onrender.com/v1/webhooks/workforce' });
    expect(s.businesses.map((b: { label: string }) => b.label)).toEqual(['Thrust Insurance', 'SavoryMind']);
  });

  it('imports the do-not-contact list into Jennifer’s suppressions, once', async () => {
    const { j, app } = setup();
    const r = (await app.inject({ method: 'POST', url: '/v1/connectors/workforce/sync-dnc', headers: OWNER, payload: {} })).json();
    expect(r).toEqual({ added: 2, total: 3 });
    expect(j.suppressions.active().map((s) => s.address).sort()).toEqual(['+13055550100', 'stop@example.com']);
    expect((await app.inject({ method: 'POST', url: '/v1/connectors/workforce/sync-dnc', headers: OWNER, payload: {} })).json()).toEqual({ added: 0, total: 3 });
    expect(normalizePhone('+39 340 123 4567')).toBe('+393401234567');
  });

  it('accepts only correctly signed lead-reply webhooks, drops replays, and alerts Bruno', async () => {
    const { app, notices } = setup();
    const body = JSON.stringify({ event: 'lead.replied', data: { sender: 'marco@acme.test', intent: 'interested', summary: 'Wants a quote for fleet cover', subject: 'Re: quote' }, sent_at: '2026-10-05T10:00:00Z' });
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    const post = (s: string, b = body) => app.inject({ method: 'POST', url: '/v1/webhooks/workforce', headers: { 'content-type': 'application/json', 'x-bruno-signature': s }, payload: b });
    expect((await post('deadbeef')).statusCode).toBe(401);
    expect((await post(sig, body.replace('fleet', 'FLEET'))).statusCode).toBe(401); // tampered body
    expect((await post(sig)).json()).toEqual({ ok: true });
    expect(notices.at(-1)).toMatchObject({ title: 'Lead replied: marco@acme.test', body: 'interested · Wants a quote for fleet cover' });
    expect((await post(sig)).json()).toMatchObject({ duplicate: true });
    expect(notices.filter((n) => n.title.startsWith('Lead replied'))).toHaveLength(1);
  });
});
