import { XMLParser } from 'fast-xml-parser';
import { JenniferError } from '../core/types.js';
import { redactSecrets } from '../security/redaction.js';

/**
 * Minimal CalDAV client (RFC 4791) for iCloud with an Apple app-specific
 * password: discovery, time-range queries, and conditional writes. Each
 * event's UID is Jennifer's idempotency key, so a retried write targets the
 * same resource and reconciliation is a GET by UID.
 */
export interface CalDavCalendar {
  url: string;
  displayName: string;
  writable: boolean;
  supportsEvents: boolean;
}

export const ICLOUD_CALDAV = 'https://caldav.icloud.com/';

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true });

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export class CalDavAuthError extends JenniferError {
  constructor() {
    super('calendar.auth_failed', 'The calendar rejected the app-specific password');
  }
}

export class CalDavClient {
  constructor(
    private o: { baseUrl: string; username: string; password: string; fetchImpl?: typeof fetch },
  ) {}

  private async req(method: string, url: string, body?: string, headers: Record<string, string> = {}): Promise<Response> {
    const res = await (this.o.fetchImpl ?? fetch)(url, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.o.username}:${this.o.password}`).toString('base64')}`,
        ...(body ? { 'content-type': method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8' } : {}),
        ...headers,
      },
      body,
    });
    if (res.status === 401 || res.status === 403) throw new CalDavAuthError();
    return res;
  }

  private abs(href: string): string {
    return new URL(href, this.o.baseUrl).toString();
  }

  private async propfind(url: string, depth: '0' | '1', props: string): Promise<any[]> {
    const res = await this.req('PROPFIND', url, `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop>${props}</d:prop></d:propfind>`, { depth });
    if (res.status !== 207) throw new JenniferError('calendar.dav_error', `PROPFIND ${res.status}: ${redactSecrets(await res.text())}`);
    return arr(parser.parse(await res.text())?.multistatus?.response);
  }

  /** Principal → calendar home → calendars that accept events. */
  async discover(): Promise<CalDavCalendar[]> {
    const [me] = await this.propfind(this.o.baseUrl, '0', '<d:current-user-principal/>');
    const principal = me?.propstat ? arr(me.propstat)[0]?.prop?.['current-user-principal']?.href : undefined;
    if (!principal) throw new JenniferError('calendar.dav_error', 'No CalDAV principal');
    const [p] = await this.propfind(this.abs(principal), '0', '<c:calendar-home-set/>');
    const home = arr(p?.propstat)[0]?.prop?.['calendar-home-set']?.href;
    if (!home) throw new JenniferError('calendar.dav_error', 'No calendar home');
    const rows = await this.propfind(this.abs(home), '1', '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><d:current-user-privilege-set/>');
    const out: CalDavCalendar[] = [];
    for (const r of rows) {
      const prop = arr(r.propstat).find((ps: any) => /200/.test(String(ps.status)))?.prop ?? {};
      if (!prop.resourcetype || !('calendar' in prop.resourcetype)) continue;
      const comps = arr(prop['supported-calendar-component-set']?.comp).map((c: any) => c['@_name']);
      const privs = JSON.stringify(prop['current-user-privilege-set'] ?? {});
      out.push({
        url: this.abs(r.href),
        displayName: String(prop.displayname ?? 'Calendar'),
        supportsEvents: comps.length === 0 || comps.includes('VEVENT'),
        writable: privs === '{}' || /write|all/.test(privs),
      });
    }
    return out.filter((c) => c.supportsEvents);
  }

  /** calendar-query REPORT with a time range; returns raw ICS bodies. */
  async query(calendarUrl: string, from: Date, to: Date): Promise<Array<{ href: string; etag?: string; ics: string }>> {
    const t = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const body = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${t(from)}" end="${t(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const res = await this.req('REPORT', calendarUrl, body, { depth: '1' });
    if (res.status !== 207) throw new JenniferError('calendar.dav_error', `REPORT ${res.status}`);
    return arr(parser.parse(await res.text())?.multistatus?.response)
      .map((r: any) => {
        const prop = arr(r.propstat)[0]?.prop ?? {};
        return { href: r.href, etag: prop.getetag, ics: String(prop['calendar-data'] ?? '') };
      })
      .filter((x) => x.ics.includes('BEGIN:VCALENDAR'));
  }

  /** Create (If-None-Match: *) or update (If-Match) one event resource. */
  async put(calendarUrl: string, uid: string, ics: string, opts: { etag?: string } = {}): Promise<{ status: 'created' | 'updated' | 'exists' | 'conflict'; etag?: string }> {
    const url = new URL(`${encodeURIComponent(uid)}.ics`, calendarUrl.endsWith('/') ? calendarUrl : `${calendarUrl}/`).toString();
    const res = await this.req('PUT', url, ics, opts.etag ? { 'if-match': opts.etag } : { 'if-none-match': '*' });
    if (res.status === 412) return { status: opts.etag ? 'conflict' : 'exists' };
    if (res.status >= 300) throw new JenniferError('calendar.dav_error', `PUT ${res.status}: ${redactSecrets(await res.text())}`);
    return { status: opts.etag ? 'updated' : 'created', etag: res.headers.get('etag') ?? undefined };
  }

  async get(calendarUrl: string, uid: string): Promise<{ ics: string; etag?: string } | undefined> {
    const url = new URL(`${encodeURIComponent(uid)}.ics`, calendarUrl.endsWith('/') ? calendarUrl : `${calendarUrl}/`).toString();
    const res = await this.req('GET', url);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new JenniferError('calendar.dav_error', `GET ${res.status}`);
    return { ics: await res.text(), etag: res.headers.get('etag') ?? undefined };
  }
}
