import ical, { type VEvent } from 'node-ical';
import { DateTime } from 'luxon';
import type { CalendarEvent } from './calendar.js';

/**
 * iCalendar (RFC 5545) helpers: parse a calendar into concrete event
 * instances inside a window (recurrences, exceptions and time zones
 * expanded), and serialize Jennifer's events for CalDAV writes.
 */
export interface IcsInstance {
  uid: string;
  title: string;
  startUtc: string;
  endUtc: string;
  timeZone: string;
  allDay: boolean;
  location?: string;
  attendees: string[];
  recurring: boolean;
  /** Free = transparent (does not block time). */
  busy: boolean;
}

function attendeeList(ev: VEvent): string[] {
  const raw = (ev as unknown as { attendee?: unknown }).attendee;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return arr
    .map((a) => (typeof a === 'string' ? a : ((a as { val?: string }).val ?? '')))
    .map((v) => v.replace(/^mailto:/i, '').toLowerCase())
    .filter((v) => v.includes('@'));
}

export function parseIcs(text: string, window: { from: Date; to: Date }, fallbackZone = 'Europe/Rome'): IcsInstance[] {
  const data = ical.sync.parseICS(text);
  const out: IcsInstance[] = [];
  for (const c of Object.values(data)) {
    if (!c || (c as { type?: string }).type !== 'VEVENT') continue;
    const ev = c as VEvent;
    if ((ev as unknown as { status?: string }).status === 'CANCELLED') continue;
    const tz = (ev.start as unknown as { tz?: string })?.tz;
    const zone = tz && tz !== 'Etc/UTC' && DateTime.local().setZone(tz).isValid ? tz : fallbackZone;
    const busy = String((ev as unknown as { transparency?: string }).transparency ?? 'OPAQUE').toUpperCase() !== 'TRANSPARENT';
    const allDayEvent = (ev.start as unknown as { dateOnly?: boolean })?.dateOnly === true || ev.datetype === 'date';
    const instances = ical.expandRecurringEvent(ev, { from: window.from, to: window.to });
    for (const i of instances) {
      const start = new Date(i.start as unknown as Date);
      const end = new Date((i.end as unknown as Date) ?? start);
      if (end < window.from || start > window.to) continue;
      out.push({
        uid: String(ev.uid),
        title: String((i as unknown as { summary?: unknown }).summary ?? ev.summary ?? '(busy)'),
        startUtc: start.toISOString(),
        endUtc: end.toISOString(),
        timeZone: zone,
        allDay: allDayEvent || !!(i as unknown as { isFullDay?: boolean }).isFullDay,
        location: ev.location ? String(ev.location) : undefined,
        attendees: attendeeList(ev),
        recurring: !!ev.rrule,
        busy,
      });
    }
  }
  return out.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

// RFC 5545 TEXT escaping; any CR/LF becomes \n and other control characters are dropped so a title can never start a new property.
const esc = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const utcStamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Fold long content lines at 75 octets (RFC 5545 §3.1). */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

/** Serialize one event. Times are written in UTC; the intended zone is kept in X-JENNIFER-TZ. */
export function buildIcs(ev: CalendarEvent, uid: string, now: Date, organizer?: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Jennifer//Assistant//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(now.toISOString())}`,
    `DTSTART:${utcStamp(ev.startUtc)}`,
    `DTEND:${utcStamp(ev.endUtc)}`,
    `SUMMARY:${esc(ev.title)}`,
    ...(ev.location ? [`LOCATION:${esc(ev.location)}`] : []),
    `X-JENNIFER-TZ:${ev.timeZone}`,
    `X-JENNIFER-LOCAL-START:${ev.localStart}`,
    ...(organizer ? [`ORGANIZER:mailto:${organizer}`] : []),
    ...ev.attendees.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:${a}`),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
