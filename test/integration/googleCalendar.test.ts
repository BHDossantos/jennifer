import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDurableJennifer } from '../../src/app.js';
import { pgliteDb } from '../../src/db/db.js';
import { FakeClock } from '../../src/core/util.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { Vault, LocalKeyWrapper } from '../../src/identity/vault.js';
import { CalendarConnections } from '../../src/calendar/remotes.js';
import { googleEventId } from '../../src/calendar/google.js';

function fakeGoogle() {
  const events = new Map<string, any>();
  let n = 0;
  const calls: Array<{ method: string; url: string; body?: any; headers?: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body && typeof init.body === 'string' ? (init.body.startsWith('{') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body))) : undefined;
    calls.push({ method, url, body, headers: init.headers });
    if (url === 'https://oauth2.googleapis.com/token') {
      if (body.grant_type === 'authorization_code') {
        expect(body.code_verifier).toBeTruthy();
        return new Response(JSON.stringify({ access_token: 'at1', expires_in: 3600, refresh_token: 'rt1' }), { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: 'at2', expires_in: 3600 }), { status: 200 });
    }
    const u = new URL(url);
    expect(u.pathname.startsWith('/calendar/v3/calendars/primary/events')).toBe(true);
    const id = u.pathname.split('/events/')[1];
    if (method === 'GET' && !id) return new Response(JSON.stringify({ items: [...events.values()] }), { status: 200 });
    if (method === 'GET') return events.has(id!) ? new Response(JSON.stringify(events.get(id!)), { status: 200 }) : new Response('{}', { status: 404 });
    if (method === 'POST') {
      if (events.has(body.id)) return new Response('{}', { status: 409 });
      const ev = { ...body, etag: `"e${++n}"`, status: 'confirmed' };
      events.set(body.id, ev);
      return new Response(JSON.stringify(ev), { status: 200 });
    }
    if (method === 'PUT') {
      const cur = events.get(id!);
      if (!cur || (init.headers as Record<string, string>)['if-match'] !== cur.etag) return new Response('{}', { status: 412 });
      const ev = { ...body, etag: `"e${++n}"`, status: 'confirmed' };
      events.set(id!, ev);
      return new Response(JSON.stringify(ev), { status: 200 });
    }
    return new Response('{}', { status: 400 });
  }) as unknown as typeof fetch;
  return { fetchImpl, events, calls };
}

describe('Google Calendar read and write (Google sign-in)', () => {
  it('connects with state + PKCE, writes with an idempotent event id, edits with If-Match, survives restart', async () => {
    const g = fakeGoogle();
    const db = await pgliteDb();
    const clock = new FakeClock('2026-10-19T07:00:00Z');
    const j = await createDurableJennifer({ db, clock, emailConnectors: [new FakeEmailProvider()], config: { ownerId: 'bruno', homeTimeZone: 'Europe/Rome' } });
    const vault = new Vault(db, new LocalKeyWrapper(new Map([[1, randomBytes(32)]])));
    const google = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'secret', redirectUri: 'https://jennifer.example.com/v1/connectors/google-calendar/callback' };
    const cals = new CalendarConnections({ db, vault, clock, audit: j.audit, capabilities: j.capabilities, calendar: j.calendar, ownerId: 'bruno', environment: 'test', fetchImpl: g.fetchImpl, google, homeTimeZone: 'Europe/Rome' });

    const { url } = cals.startGoogle();
    const auth = new URL(url);
    expect(auth.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('redirect_uri')).toBe(google.redirectUri);
    const state = auth.searchParams.get('state')!;
    await expect(cals.finishGoogle('code', 'forged-state', 'bruno')).rejects.toThrow(/expired or was already used/);
    await cals.finishGoogle('code', state, 'bruno');
    await expect(cals.finishGoogle('code', state, 'bruno')).rejects.toThrow(/already used/); // single use
    expect(j.capabilities.get('google_calendar')!.connected).toBe(true);

    // A meeting Bruno approves is created once, even if the create is retried.
    const ctx = { ownerId: 'bruno', role: 'chat', allowedTools: new Set(['propose_event']), scopes: new Set(['calendar:propose']) };
    const p = (await j.tools.invoke('propose_event', { title: 'Call with Marco', date: '2026-10-22', time: '15:00', durationMin: 30, attendees: [] }, ctx)) as { actionId: string };
    const a = j.actions.get(p.actionId);
    j.actions.approve(a.id, 'bruno', { revision: a.revision, payloadHash: a.payloadHash });
    await j.actions.runDue();
    expect(j.actions.get(a.id).state).toBe('provider_accepted');
    const id = googleEventId(a.idempotencyKey);
    expect(g.events.get(id)).toMatchObject({ summary: 'Call with Marco', start: { dateTime: '2026-10-22T13:00:00.000Z', timeZone: 'Europe/Rome' } });
    const created = (a.payload as { event: Parameters<NonNullable<ReturnType<typeof j.calendar.writer>>['upsert']>[0] }).event;
    expect((await j.calendar.writer()!.upsert({ ...created, etag: undefined }, a.idempotencyKey)).status).toBe('exists'); // retried create
    expect([...g.events.keys()]).toEqual([id]);

    // Someone moved it in Google meanwhile: Jennifer's stale edit is refused, never a blind overwrite.
    await cals.syncNow();
    const mirrored = [...j.calendar.provider.events.values()].find((e) => e.title === 'Call with Marco')!;
    g.events.set(id, { ...g.events.get(id), etag: '"changed-elsewhere"' });
    const r = await j.calendar.writer(mirrored.source)!.upsert({ ...mirrored, title: 'Moved' }, mirrored.uid!);
    expect(r.status).toBe('conflict');

    // Restart: the refresh token comes back from the vault.
    j.calendar.detach('gcal:primary');
    const again = new CalendarConnections({ db, vault, clock, audit: j.audit, capabilities: j.capabilities, calendar: j.calendar, ownerId: 'bruno', environment: 'test', fetchImpl: g.fetchImpl, google, homeTimeZone: 'Europe/Rome' });
    expect(await again.resume()).toBe(1);
    expect(j.calendar.writer()!.id).toBe('gcal:primary');
    await j.store.flush();
    await db.close();
  });
});
