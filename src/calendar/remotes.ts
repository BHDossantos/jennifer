import { JenniferError } from '../core/types.js';
import { type Clock } from '../core/util.js';
import type { Db } from '../db/db.js';
import type { Vault } from '../identity/vault.js';
import type { AuditLog } from '../audit/audit.js';
import type { CapabilityRegistry } from '../connectors/capabilities.js';
import { isAllowedEgress, safeFetchText } from '../security/untrusted.js';
import { CalDavAuthError, CalDavClient, ICLOUD_CALDAV, type CalDavCalendar } from './caldav.js';
import { buildIcs, parseIcs } from './ics.js';
import type { CalendarEvent, CalendarService, RemoteCalendar } from './calendar.js';

function toEvents(source: string, calendarId: string, items: ReturnType<typeof parseIcs>): CalendarEvent[] {
  return items.map((i) => ({
    id: `${source}:${i.uid}:${i.startUtc}`,
    calendarId,
    title: i.title,
    startUtc: i.startUtc,
    endUtc: i.endUtc,
    timeZone: i.timeZone,
    localStart: i.startUtc.slice(0, 16),
    localEnd: i.endUtc.slice(0, 16),
    attendees: i.attendees,
    location: i.location,
    uid: i.uid,
    providerEventId: i.uid,
    source,
    busy: i.busy && !i.allDay, // all-day items (birthdays, holidays) don't block meeting slots
  }));
}

/** iCloud (or any CalDAV) calendar: read + write. */
export class CalDavRemote implements RemoteCalendar {
  readonly writable = true;
  constructor(
    readonly id: string,
    readonly label: string,
    private client: CalDavClient,
    private calendarUrl: string,
    private clock: Clock,
    private organizer?: string,
  ) {}

  async list(from: Date, to: Date): Promise<CalendarEvent[]> {
    const rows = await this.client.query(this.calendarUrl, from, to);
    return rows.flatMap((r) => toEvents(this.id, 'primary', parseIcs(r.ics, { from, to })).map((e) => ({ ...e, etag: r.etag })));
  }

  async upsert(ev: CalendarEvent, uid: string) {
    const ics = buildIcs(ev, uid, this.clock.now(), this.organizer);
    if (ev.etag) return this.client.put(this.calendarUrl, uid, ics, { etag: ev.etag });
    const existing = await this.client.get(this.calendarUrl, uid);
    return existing ? this.client.put(this.calendarUrl, uid, ics, { etag: existing.etag }) : this.client.put(this.calendarUrl, uid, ics);
  }

  async has(uid: string): Promise<boolean> {
    return !!(await this.client.get(this.calendarUrl, uid));
  }
}

/** A secret iCal address (e.g. Google Calendar → "Secret address in iCal format"): read-only. */
export class IcsFeedRemote implements RemoteCalendar {
  readonly writable = false;
  constructor(
    readonly id: string,
    readonly label: string,
    private url: string,
    private fetchImpl: typeof fetch = fetch,
    /** DNS resolution override (tests); production resolves and rejects private addresses. */
    private resolve?: (host: string) => Promise<string[]>,
  ) {}

  async list(from: Date, to: Date): Promise<CalendarEvent[]> {
    let res;
    try {
      res = await safeFetchText(this.url, { headers: { accept: 'text/calendar' }, maxBytes: 20 * 1024 * 1024, fetchImpl: this.fetchImpl, resolve: this.resolve });
    } catch (e) {
      throw new JenniferError('calendar.feed_error', `Calendar feed could not be read: ${(e as Error).message}`);
    }
    if (res.status < 200 || res.status >= 300) throw new JenniferError('calendar.feed_error', `Calendar feed returned ${res.status}`);
    const text = res.text;
    return toEvents(this.id, 'primary', parseIcs(text, { from, to }));
  }

  async upsert(): Promise<never> {
    throw new JenniferError('calendar.read_only', `${this.label} is read-only`);
  }

  async has(): Promise<boolean> {
    return false;
  }
}

/**
 * Connect flows. Credentials (Apple app-specific password, secret feed
 * URL) live only in the vault, bound to this account and environment.
 */
export class CalendarConnections {
  constructor(
    private d: {
      db: Db;
      vault: Vault;
      clock: Clock;
      audit: AuditLog;
      capabilities: CapabilityRegistry;
      calendar: CalendarService;
      ownerId: string;
      environment: string;
      caldavBase?: string;
      fetchImpl?: typeof fetch;
      resolve?: (host: string) => Promise<string[]>;
    },
  ) {}

  private binding(accountId: string) {
    return { ownerId: this.d.ownerId, accountId, environment: this.d.environment };
  }

  async connectICloud(appleId: string, appPassword: string, actor: string, preferred?: string): Promise<{ calendar: string; calendars: string[] }> {
    const username = appleId.trim().toLowerCase();
    const password = appPassword.replace(/\s+/g, '');
    const client = new CalDavClient({ baseUrl: this.d.caldavBase ?? ICLOUD_CALDAV, username, password, fetchImpl: this.d.fetchImpl });
    let cals: CalDavCalendar[];
    try {
      cals = (await client.discover()).filter((c) => c.writable);
    } catch (e) {
      if (e instanceof CalDavAuthError) throw new JenniferError('calendar.auth_failed', 'Apple rejected the app-specific password');
      throw e;
    }
    if (cals.length === 0) throw new JenniferError('calendar.none', 'No writable calendars found');
    const pick = cals.find((c) => preferred && c.displayName.toLowerCase() === preferred.toLowerCase()) ?? cals.find((c) => /^(home|calendar|personal|casa)$/i.test(c.displayName)) ?? cals[0]!;
    const accountId = `icloud:${username}`;
    await this.d.vault.put(accountId, JSON.stringify({ username, password, calendarUrl: pick.url, label: pick.displayName }), this.binding(accountId));
    await this.save(accountId, 'icloud_calendar', username);
    this.attachICloud(accountId, username, password, pick.url, pick.displayName);
    this.d.audit.record(actor, 'connector.connected', accountId, { connector: 'icloud_calendar', calendar: pick.displayName });
    await this.syncNow();
    return { calendar: pick.displayName, calendars: cals.map((c) => c.displayName) };
  }

  async connectIcsFeed(url: string, label: string, actor: string): Promise<{ events: number }> {
    const u = url.trim().replace(/^webcal:/i, 'https:');
    if (!/^https:\/\//i.test(u) || !isAllowedEgress(u)) throw new JenniferError('calendar.bad_url', 'Use the https secret iCal address');
    const id = `ics:${Buffer.from(u).toString('base64url').slice(-16)}`;
    const remote = new IcsFeedRemote(id, label, u, this.d.fetchImpl, this.d.resolve);
    const events = await remote.list(this.d.clock.now(), new Date(this.d.clock.now().getTime() + 7 * 24 * 3600_000)); // validate before saving
    await this.d.vault.put(id, JSON.stringify({ url: u, label }), this.binding(id));
    await this.save(id, 'google_calendar_ics', label);
    this.d.calendar.attach(remote);
    this.d.capabilities.markConnected('google_calendar_ics', id, label);
    this.d.audit.record(actor, 'connector.connected', id, { connector: 'google_calendar_ics' });
    await this.syncNow();
    return { events: events.length };
  }

  async resume(): Promise<number> {
    const rows = (
      await this.d.db.query<{ id: string; connector_id: string }>(
        `SELECT id, connector_id FROM account_connection WHERE owner_id = $1 AND environment = $2 AND connected AND revoked_at IS NULL AND connector_id IN ('icloud_calendar','google_calendar_ics')`,
        [this.d.ownerId, this.d.environment],
      )
    ).rows;
    for (const r of rows) {
      const secret = JSON.parse(await this.d.vault.get(r.id, this.binding(r.id)));
      if (r.connector_id === 'icloud_calendar') this.attachICloud(r.id, secret.username, secret.password, secret.calendarUrl, secret.label);
      else {
        this.d.calendar.attach(new IcsFeedRemote(r.id, secret.label, secret.url, this.d.fetchImpl, this.d.resolve));
        this.d.capabilities.markConnected('google_calendar_ics', r.id, secret.label);
      }
    }
    if (rows.length) await this.syncNow();
    return rows.length;
  }

  async disconnect(id: string, actor: string): Promise<void> {
    this.d.calendar.detach(id);
    await this.d.vault.revoke(id);
    await this.d.db.query('UPDATE account_connection SET connected = false, revoked_at = now() WHERE id = $1', [id]);
    this.d.capabilities.markDisconnected(id.startsWith('icloud:') ? 'icloud_calendar' : 'google_calendar_ics', 'disconnected by Bruno');
    this.d.audit.record(actor, 'connector.disconnected', id, {});
  }

  async syncNow(): Promise<{ events: number; errors: string[] }> {
    const r = await this.d.calendar.sync();
    for (const remote of this.d.calendar.remotes) {
      const connector = remote.id.startsWith('icloud:') ? 'icloud_calendar' : 'google_calendar_ics';
      const failed = r.errors.find((e) => e.startsWith(`${remote.label}:`));
      if (!failed) {
        this.d.capabilities.recordSync(connector);
        this.d.capabilities.markVerified(connector, 'read', 'calendar sync succeeded');
      } else if (/rejected/.test(failed)) this.d.capabilities.markDisconnected(connector, failed);
    }
    return r;
  }

  private attachICloud(accountId: string, username: string, password: string, calendarUrl: string, label: string) {
    const client = new CalDavClient({ baseUrl: this.d.caldavBase ?? ICLOUD_CALDAV, username, password, fetchImpl: this.d.fetchImpl });
    this.d.calendar.attach(new CalDavRemote(accountId, `iCloud ${label}`, client, calendarUrl, this.d.clock, username));
    this.d.capabilities.markConnected('icloud_calendar', accountId, `iCloud ${label}`);
  }

  private async save(id: string, connector: string, external: string) {
    await this.d.db.query(
      `INSERT INTO account_connection (id, owner_id, connector_id, environment, external_account, vault_secret_ref, scopes, capabilities, connected)
       VALUES ($1,$2,$3,$4,$5,$1,$6,$7,true)
       ON CONFLICT (id) DO UPDATE SET connected = true, revoked_at = NULL, last_error = NULL`,
      [id, this.d.ownerId, connector, this.d.environment, external, ['calendar'], JSON.stringify({})],
    );
  }
}
