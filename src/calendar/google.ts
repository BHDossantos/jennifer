import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { JenniferError } from '../core/types.js';
import { redactSecrets } from '../security/redaction.js';
import type { CalendarEvent, RemoteCalendar } from './calendar.js';

/**
 * Google Calendar read and write through the Calendar API, with Bruno's
 * consent via Google sign-in (OAuth authorization code + PKCE + state,
 * exact redirect URI, narrowest scope: calendar.events). The refresh token
 * lives only in the vault. Needs a free Google Cloud project for the
 * OAuth client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
 */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export class GoogleOAuth {
  constructor(private c: GoogleOAuthConfig) {}

  authUrl(state: string, challenge: string): string {
    const u = new URL(AUTH_URL);
    u.search = new URLSearchParams({
      client_id: this.c.clientId,
      redirect_uri: this.c.redirectUri,
      response_type: 'code',
      scope: GOOGLE_CALENDAR_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return u.toString();
  }

  private async token(params: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string; scope?: string }> {
    const res = await (this.c.fetchImpl ?? fetch)(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.c.clientId, client_secret: this.c.clientSecret, ...params }).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      const revoked = json.error === 'invalid_grant';
      throw new JenniferError(revoked ? 'calendar.auth_failed' : 'calendar.google_error', revoked ? 'Google access was revoked or expired; reconnect Google Calendar' : `Google sign-in failed: ${redactSecrets(json.error_description ?? json.error ?? String(res.status))}`);
    }
    return json as { access_token: string; expires_in: number; refresh_token?: string; scope?: string };
  }

  async exchange(code: string, verifier: string): Promise<{ refreshToken: string; scope?: string }> {
    const t = await this.token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: this.c.redirectUri });
    if (!t.refresh_token) throw new JenniferError('calendar.google_error', 'Google did not return offline access; remove Jennifer from your Google account permissions and try again');
    return { refreshToken: t.refresh_token, scope: t.scope };
  }

  refresh(refreshToken: string) {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }
}

/** Google event ids must be base32hex (a-v, 0-9), 5–1024 chars; Jennifer's UIDs map deterministically. */
export function googleEventId(uid: string): string {
  return /^[a-v0-9]{5,1024}$/.test(uid) ? uid : createHash('sha256').update(uid).digest('hex');
}

interface GEvent {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  location?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email?: string }>;
  extendedProperties?: { private?: Record<string, string> };
}

export class GoogleCalendarRemote implements RemoteCalendar {
  readonly writable = true;
  private access?: { token: string; until: number };

  constructor(
    readonly id: string,
    readonly label: string,
    private oauth: GoogleOAuth,
    private refreshToken: string,
    private homeZone: string,
    private calendarId = 'primary',
    private fetchImpl?: typeof fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.access && Date.now() < this.access.until) return this.access.token;
    const t = await this.oauth.refresh(this.refreshToken);
    this.access = { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 };
    return t.access_token;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await (this.fetchImpl ?? fetch)(`${API}/calendars/${encodeURIComponent(this.calendarId)}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    });
    if (res.status === 401) throw new JenniferError('calendar.auth_failed', 'Google rejected the access token; reconnect Google Calendar');
    return res;
  }

  async list(from: Date, to: Date): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', ...(pageToken ? { pageToken } : {}) });
      const res = await this.call(`/events?${q}`);
      if (!res.ok) throw new JenniferError('calendar.google_error', `Google Calendar list failed (${res.status})`);
      const json = (await res.json()) as { items?: GEvent[]; nextPageToken?: string };
      for (const e of json.items ?? []) if (e.status !== 'cancelled') out.push(this.toEvent(e));
      pageToken = json.nextPageToken;
    } while (pageToken);
    return out;
  }

  private toEvent(e: GEvent): CalendarEvent {
    const zone = e.start?.timeZone ?? this.homeZone;
    const at = (t?: { dateTime?: string; date?: string }) => (t?.dateTime ? DateTime.fromISO(t.dateTime) : DateTime.fromISO(t?.date ?? '', { zone }));
    const s = at(e.start).toUTC();
    const en = at(e.end).toUTC();
    return {
      id: `${this.id}:${e.id}`,
      calendarId: 'primary',
      title: e.summary ?? '(no title)',
      startUtc: s.toISO()!,
      endUtc: en.toISO()!,
      timeZone: zone,
      localStart: s.setZone(zone).toFormat("yyyy-LL-dd'T'HH:mm"),
      localEnd: en.setZone(zone).toFormat("yyyy-LL-dd'T'HH:mm"),
      attendees: (e.attendees ?? []).map((a) => a.email ?? '').filter(Boolean),
      location: e.location,
      source: this.id,
      uid: e.id,
      etag: e.etag,
      providerEventId: e.id,
      busy: e.transparency !== 'transparent',
    };
  }

  private body(ev: CalendarEvent, id: string) {
    return {
      id,
      summary: ev.title,
      location: ev.location,
      start: { dateTime: ev.startUtc, timeZone: ev.timeZone },
      end: { dateTime: ev.endUtc, timeZone: ev.timeZone },
      attendees: ev.attendees.map((email) => ({ email })),
      transparency: ev.busy === false ? 'transparent' : 'opaque',
      extendedProperties: { private: { jenniferUid: id } },
    };
  }

  async upsert(ev: CalendarEvent, uid: string): Promise<{ status: 'created' | 'updated' | 'exists' | 'conflict'; etag?: string }> {
    const id = googleEventId(uid);
    if (ev.etag) {
      // Update only if nobody changed it since Jennifer read it.
      const res = await this.call(`/events/${id}?sendUpdates=all`, { method: 'PUT', headers: { 'if-match': ev.etag }, body: JSON.stringify(this.body(ev, id)) });
      if (res.status === 412) return { status: 'conflict' };
      if (!res.ok) throw new JenniferError('calendar.google_error', `Google Calendar update failed (${res.status})`);
      return { status: 'updated', etag: ((await res.json()) as GEvent).etag };
    }
    // The id is derived from Jennifer's idempotency key: a retried create gets 409 instead of a duplicate.
    const res = await this.call(`/events?sendUpdates=all`, { method: 'POST', body: JSON.stringify(this.body(ev, id)) });
    if (res.status === 409) return { status: 'exists' };
    if (!res.ok) throw new JenniferError('calendar.google_error', `Google Calendar create failed (${res.status})`);
    return { status: 'created', etag: ((await res.json()) as GEvent).etag };
  }

  async has(uid: string): Promise<boolean> {
    const res = await this.call(`/events/${googleEventId(uid)}`);
    if (res.status === 404 || res.status === 410) return false;
    if (!res.ok) throw new JenniferError('calendar.google_error', `Google Calendar lookup failed (${res.status})`);
    return ((await res.json()) as GEvent).status !== 'cancelled';
  }
}
