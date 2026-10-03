import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createDurableJennifer } from '../../src/app.js';
import { pgliteDb } from '../../src/db/db.js';
import { FakeClock } from '../../src/core/util.js';
import { LocalKeyWrapper, Vault } from '../../src/identity/vault.js';
import { CalendarConnections } from '../../src/calendar/remotes.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';

const BASE = 'https://caldav.test/';
const APPLE_ID = 'bruno@icloud.test';
const APP_PW = 'abcd-efgh-ijkl-mnop';

const gymIcs = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:gym-1\r\nDTSTART;TZID=Europe/Rome:20261020T180000\r\nDTEND;TZID=Europe/Rome:20261020T190000\r\nRRULE:FREQ=WEEKLY;COUNT=4\r\nSUMMARY:Gym\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const birthdayIcs = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:bday-1\r\nDTSTART;VALUE=DATE:20261021\r\nDTEND;VALUE=DATE:20261022\r\nSUMMARY:Mom's birthday\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

/** In-memory CalDAV server speaking just enough of RFC 4791 (like iCloud). */
function fakeCalDav() {
  const store = new Map<string, { ics: string; etag: string }>([
    ['/123/calendars/home/gym-1.ics', { ics: gymIcs, etag: '"e1"' }],
    ['/123/calendars/home/bday-1.ics', { ics: birthdayIcs, etag: '"e2"' }],
  ]);
  let n = 3;
  let dropAfterPut = false;
  const ms = (inner: string) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${inner}</d:multistatus>`, { status: 207 });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    if (h.authorization !== `Basic ${Buffer.from(`${APPLE_ID}:${APP_PW.replace(/\s/g, '')}`).toString('base64')}`) return new Response('', { status: 401 });
    const path = new URL(url).pathname;
    const body = String(init.body ?? '');
    if (init.method === 'PROPFIND' && path === '/') return ms(`<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/123/principal/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
    if (init.method === 'PROPFIND' && path === '/123/principal/') return ms(`<d:response><d:href>/123/principal/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/123/calendars/</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
    if (init.method === 'PROPFIND' && path === '/123/calendars/')
      return ms(
        `<d:response><d:href>/123/calendars/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
          `<d:response><d:href>/123/calendars/home/</d:href><d:propstat><d:prop><d:displayname>Home</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
          `<d:response><d:href>/123/calendars/reminders/</d:href><d:propstat><d:prop><d:displayname>Reminders</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
      );
    if (init.method === 'REPORT') {
      const items = [...store.entries()].filter(([k]) => k.startsWith(path));
      return ms(items.map(([k, v]) => `<d:response><d:href>${k}</d:href><d:propstat><d:prop><d:getetag>${v.etag}</d:getetag><c:calendar-data>${v.ics.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join(''));
    }
    if (init.method === 'PUT') {
      const existing = store.get(path);
      if (h['if-none-match'] === '*' && existing) return new Response('', { status: 412 });
      if (h['if-match'] && (!existing || existing.etag !== h['if-match'])) return new Response('', { status: 412 });
      const etag = `"e${n++}"`;
      store.set(path, { ics: body, etag });
      if (dropAfterPut) {
        dropAfterPut = false;
        throw new Error('socket hang up');
      }
      return new Response('', { status: existing ? 204 : 201, headers: { etag } });
    }
    if (init.method === 'GET') {
      const v = store.get(path);
      return v ? new Response(v.ics, { status: 200, headers: { etag: v.etag } }) : new Response('', { status: 404 });
    }
    return new Response('', { status: 405 });
  }) as unknown as typeof fetch;
  return { fetchImpl, store, dropNextPut: () => (dropAfterPut = true) };
}

async function setup() {
  const dav = fakeCalDav();
  const feedFetch = (async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://calendar.google.test/')) return new Response(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:g-1\r\nDTSTART:20261021T080000Z\r\nDTEND:20261021T093000Z\r\nSUMMARY:Insurance review\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`, { status: 200 });
    return dav.fetchImpl(url, init as RequestInit);
  }) as unknown as typeof fetch;
  const db = await pgliteDb();
  const clock = new FakeClock('2026-10-19T07:00:00Z');
  const j = await createDurableJennifer({ db, clock, emailConnectors: [new FakeEmailProvider()], config: { ownerId: 'bruno', homeTimeZone: 'Europe/Rome' } });
  const cals = new CalendarConnections({ db, vault: new Vault(db, new LocalKeyWrapper(new Map([[1, randomBytes(32)]]))), clock, audit: j.audit, capabilities: j.capabilities, calendar: j.calendar, ownerId: 'bruno', environment: 'test', caldavBase: BASE, fetchImpl: feedFetch });
  const ctx = { ownerId: 'bruno', role: 'chat', allowedTools: new Set(['get_calendar', 'find_free_slots', 'propose_event']), scopes: new Set(['calendar:read', 'calendar:propose']) };
  return { db, j, cals, dav, clock, ctx };
}

describe('Calendar without Google Cloud (iCloud CalDAV + Google iCal feed)', () => {
  it('connects iCloud, picks the event calendar, mirrors recurring events across DST; all-day items do not block time', async () => {
    const { j, cals, ctx, db } = await setup();
    await expect(cals.connectICloud(APPLE_ID, 'wrong-password-xx', 'bruno')).rejects.toThrow(/rejected the app-specific password/);
    const r = await cals.connectICloud(APPLE_ID, APP_PW, 'bruno');
    expect(r).toEqual({ calendar: 'Home', calendars: ['Home'] }); // the reminders (VTODO) list is excluded
    const gyms = [...j.calendar.provider.events.values()].filter((e) => e.title === 'Gym');
    expect(gyms.map((g) => g.startUtc)).toEqual(['2026-10-20T16:00:00.000Z', '2026-10-27T17:00:00.000Z', '2026-11-03T17:00:00.000Z', '2026-11-10T17:00:00.000Z']); // 18:00 Rome before and after DST
    const slots = (await j.tools.invoke('find_free_slots', { dates: ['2026-10-20', '2026-10-21'], durationMin: 60, fromHour: 17, toHour: 20 }, ctx)) as string[];
    expect(slots).not.toContain('Tue 20 Oct 18:00');
    expect(slots).toContain('Wed 21 Oct 18:00'); // the birthday (all-day) does not block
    expect(j.capabilities.get('icloud_calendar')!.capabilities.read.status).toBe('verified');
    await j.store.flush();
    await db.close();
  });

  it('a proposed meeting is written to iCloud only with authority, with UID = idempotency key', async () => {
    const { j, cals, ctx, dav, db } = await setup();
    await cals.connectICloud(APPLE_ID, APP_PW, 'bruno');
    const p = (await j.tools.invoke('propose_event', { title: 'Call with Marco', date: '2026-10-22', time: '15:00', durationMin: 30, attendees: ['marco@bianchi.test'] }, ctx)) as { actionId: string; state: string; when: string };
    expect(p.state).toBe('awaiting_decision');
    expect(p.when).toBe('Thu 22 Oct 15:00');
    const a = j.actions.get(p.actionId);
    j.actions.approve(a.id, 'bruno', { revision: a.revision, payloadHash: a.payloadHash });
    await j.actions.execute(a.id);
    expect(j.actions.get(a.id).state).toBe('provider_accepted');
    const raw = dav.store.get(`/123/calendars/home/${a.idempotencyKey}.ics`)!;
    expect(raw.ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75)).toBe(true); // RFC 5545 line folding
    const stored = { ics: raw.ics.replace(/\r\n /g, '') };
    expect(stored.ics).toMatch(/DTSTART:20261022T130000Z/);
    expect(stored.ics).toMatch(/ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:marco@bianchi.test/);
    expect(stored.ics).toMatch(/X-JENNIFER-TZ:Europe\/Rome/);
    await j.store.flush();
    await db.close();
  });

  it('a dropped connection after the server stored the event is reconciled, not duplicated', async () => {
    const { j, cals, ctx, dav, db } = await setup();
    await cals.connectICloud(APPLE_ID, APP_PW, 'bruno');
    j.authority.grant({ principal: 'bruno', action: 'create_event', mode: 'execute', scope: { spaces: ['personal'] } });
    dav.dropNextPut();
    const p = (await j.tools.invoke('propose_event', { title: 'Dentist', date: '2026-10-23', time: '10:00', durationMin: 45 }, ctx)) as { actionId: string; state: string };
    expect(p.state).toBe('ready');
    await j.actions.execute(p.actionId);
    expect(j.actions.get(p.actionId).state).toBe('unknown');
    await j.actions.recoverUnknown();
    expect(j.actions.get(p.actionId).state).toBe('provider_accepted');
    expect([...dav.store.keys()].filter((k) => k.endsWith(`${j.actions.get(p.actionId).idempotencyKey}.ics`))).toHaveLength(1);
    await j.store.flush();
    await db.close();
  });

  it('a Google secret iCal feed is read-only, blocks time, and a failed refresh keeps the last good copy', async () => {
    const { j, cals, ctx, db } = await setup();
    await expect(cals.connectIcsFeed('http://169.254.169.254/latest', 'x', 'bruno')).rejects.toThrow(/secret iCal address/);
    expect((await cals.connectIcsFeed('https://calendar.google.test/calendar/ical/abc/private-xyz/basic.ics', 'Google Calendar', 'bruno')).events).toBe(1);
    const cal = (await j.tools.invoke('get_calendar', { hours: 72 }, ctx)) as { calendars: string[]; events: Array<{ title: string; start: string }> };
    expect(cal.calendars).toEqual(['Google Calendar']);
    expect(cal.events.find((e) => e.title === 'Insurance review')!.start).toBe('Wed 21 Oct 10:00');
    // No writable calendar: proposing an event cannot pretend to succeed.
    const p = (await j.tools.invoke('propose_event', { title: 'X', date: '2026-10-22', time: '09:00', durationMin: 30 }, ctx)) as { state: string };
    expect(p.state).toBe('failed');
    // Feed outage: mirror is kept, error reported.
    j.calendar.remotes[0]!.list = async () => {
      throw new Error('503');
    };
    const r = await cals.syncNow();
    expect(r.errors[0]).toMatch(/503/);
    expect([...j.calendar.provider.events.values()].some((e) => e.title === 'Insurance review')).toBe(true);
    await j.store.flush();
    await db.close();
  });
});
