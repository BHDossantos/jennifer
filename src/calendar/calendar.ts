import { DateTime, IANAZone } from 'luxon';
import { JenniferError } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import type { CapabilityRegistry } from '../connectors/capabilities.js';
import type { ContactDirectory } from '../contacts/contacts.js';
import type { ActionHandler, ActionIntent, PerformResult, ResolvedAction } from '../actions/model.js';

/**
 * Events store UTC instants plus the IANA zone and the original local
 * schedule (spec §6). Rome routines use Europe/Rome regardless of the
 * traveling device's timezone.
 */
export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  startUtc: string;
  endUtc: string;
  timeZone: string;
  localStart: string; // e.g. '2026-10-29T15:00' in timeZone
  localEnd: string;
  attendees: string[];
  location?: string;
  travelBufferMin?: number;
  recurrence?: string; // RFC 5545 RRULE, expanded by the provider
  providerEventId?: string;
  idempotencyKey?: string;
}

export interface LocalTimeSpec {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  timeZone: string;
}

export function assertZone(zone: string): void {
  if (!IANAZone.isValidZone(zone)) throw new JenniferError('calendar.bad_zone', `Unknown IANA time zone ${zone}`);
}

/** Convert a local wall-clock time in a zone to a UTC instant, rejecting nonexistent (DST gap) times. */
export function localToUtc(spec: LocalTimeSpec): DateTime {
  assertZone(spec.timeZone);
  const dt = DateTime.fromISO(`${spec.date}T${spec.time}`, { zone: spec.timeZone });
  if (!dt.isValid) throw new JenniferError('calendar.bad_time', `Invalid local time ${spec.date} ${spec.time}`);
  if (dt.toFormat('HH:mm') !== spec.time) throw new JenniferError('calendar.dst_gap', `${spec.date} ${spec.time} does not exist in ${spec.timeZone} (DST change)`);
  return dt.toUTC();
}

export function describeLocal(utcIso: string, zone: string): string {
  return DateTime.fromISO(utcIso, { zone: 'utc' }).setZone(zone).toFormat("cccc d LLLL yyyy 'at' HH:mm ZZZZ");
}

export interface Busy {
  startUtc: string;
  endUtc: string;
  eventId: string;
}

/** In-memory calendar provider used by the simulator and tests. */
export class FakeCalendarProvider {
  readonly events = new Map<string, CalendarEvent>();
  failNext = false;

  async upsert(ev: CalendarEvent): Promise<{ providerEventId: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('calendar provider timeout');
    }
    const existing = [...this.events.values()].find((e) => ev.idempotencyKey && e.idempotencyKey === ev.idempotencyKey && e.id !== ev.id);
    if (existing) return { providerEventId: existing.providerEventId! };
    const providerEventId = ev.providerEventId ?? newId('gcal');
    this.events.set(ev.id, { ...ev, providerEventId });
    return { providerEventId };
  }

  async findByIdempotencyKey(key: string): Promise<CalendarEvent | undefined> {
    return [...this.events.values()].find((e) => e.idempotencyKey === key);
  }
}

export class CalendarService {
  constructor(
    private clock: Clock,
    readonly provider: FakeCalendarProvider,
  ) {}

  get(id: string): CalendarEvent {
    const e = this.provider.events.get(id);
    if (!e) throw new JenniferError('calendar.not_found', `No event ${id}`);
    return e;
  }

  busy(calendarId: string, fromUtc: DateTime, toUtc: DateTime, excludeEventId?: string): Busy[] {
    return [...this.provider.events.values()]
      .filter((e) => e.calendarId === calendarId && e.id !== excludeEventId)
      .map((e) => {
        const buf = e.travelBufferMin ?? 0;
        return {
          eventId: e.id,
          startUtc: DateTime.fromISO(e.startUtc).minus({ minutes: buf }).toUTC().toISO()!,
          endUtc: DateTime.fromISO(e.endUtc).plus({ minutes: buf }).toUTC().toISO()!,
        };
      })
      .filter((b) => DateTime.fromISO(b.startUtc) < toUtc && DateTime.fromISO(b.endUtc) > fromUtc);
  }

  conflicts(calendarId: string, startUtc: DateTime, endUtc: DateTime, travelBufferMin = 0, excludeEventId?: string): Busy[] {
    return this.busy(calendarId, startUtc.minus({ minutes: travelBufferMin }), endUtc.plus({ minutes: travelBufferMin }), excludeEventId);
  }

  /** Build an event from a local-time spec; the zone is the stated intent, not the device's zone. */
  buildEvent(input: { calendarId: string; title: string; start: LocalTimeSpec; durationMin: number; attendees: string[]; location?: string; travelBufferMin?: number; id?: string }): CalendarEvent {
    const start = localToUtc(input.start);
    const end = start.plus({ minutes: input.durationMin });
    const endLocal = end.setZone(input.start.timeZone);
    return {
      id: input.id ?? newId('ev'),
      calendarId: input.calendarId,
      title: input.title,
      startUtc: start.toISO()!,
      endUtc: end.toISO()!,
      timeZone: input.start.timeZone,
      localStart: `${input.start.date}T${input.start.time}`,
      localEnd: endLocal.toFormat("yyyy-LL-dd'T'HH:mm"),
      attendees: input.attendees.map((a) => a.toLowerCase()),
      location: input.location,
      travelBufferMin: input.travelBufferMin,
    };
  }

  /** Propose free slots in a zone's working hours (used for rescheduling replies). */
  suggestSlots(calendarId: string, zone: string, dates: string[], durationMin: number, hours: [number, number] = [9, 18], stepMin = 30): DateTime[] {
    const out: DateTime[] = [];
    const now = DateTime.fromJSDate(this.clock.now());
    for (const date of dates) {
      for (let m = hours[0] * 60; m + durationMin <= hours[1] * 60; m += stepMin) {
        const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        let start: DateTime;
        try {
          start = localToUtc({ date, time: t, timeZone: zone });
        } catch {
          continue;
        }
        if (start < now) continue;
        if (this.conflicts(calendarId, start, start.plus({ minutes: durationMin })).length === 0) out.push(start);
      }
    }
    return out;
  }
}

export interface CalendarActionPayload {
  event: CalendarEvent;
  /** For modify: the event id being moved. */
  replacesEventId?: string;
}

export class CalendarActionHandler implements ActionHandler<CalendarActionPayload> {
  constructor(
    readonly type: 'create_event' | 'modify_event',
    private calendar: CalendarService,
    private contacts: ContactDirectory,
    private capabilities: CapabilityRegistry,
  ) {}

  resolve(intent: ActionIntent<CalendarActionPayload>): ResolvedAction {
    const ev = intent.payload.event;
    const violations: string[] = [];
    const concerns: string[] = [];
    if (!this.capabilities.can(intent.connectorId, 'send')) violations.push(`calendar connector ${intent.connectorId} cannot write`);
    try {
      assertZone(ev.timeZone);
    } catch (e) {
      violations.push((e as Error).message);
    }
    const start = DateTime.fromISO(ev.startUtc);
    const end = DateTime.fromISO(ev.endUtc);
    if (!(end > start)) violations.push('event ends before it starts');
    const conflicts = this.calendar.conflicts(ev.calendarId, start, end, ev.travelBufferMin ?? 0, intent.payload.replacesEventId ?? ev.id);
    if (conflicts.length) violations.push(`conflicts with ${conflicts.map((c) => c.eventId).join(', ')}`);
    const contactIds: string[] = [];
    for (const a of ev.attendees) {
      const c = this.contacts.findByIdentity(intent.ownerId, 'email', a);
      if (!c) concerns.push(`attendee ${a} is not a known contact`);
      else contactIds.push(c.id);
    }
    return {
      authority: {
        action: intent.type,
        accountId: intent.accountId,
        space: intent.space,
        contactIds,
        recipientDomains: ev.attendees.map((a) => a.split('@')[1] ?? '').filter(Boolean),
        workflowId: intent.workflowId,
        attachmentSpaces: [],
        recipientCount: ev.attendees.length,
      },
      contactIds,
      addresses: ev.attendees,
      violations,
      concerns,
    };
  }

  async perform(intent: ActionIntent<CalendarActionPayload>): Promise<PerformResult> {
    const ev = { ...intent.payload.event, idempotencyKey: intent.idempotencyKey };
    if (intent.payload.replacesEventId) {
      const old = this.calendar.get(intent.payload.replacesEventId);
      ev.id = old.id;
      ev.providerEventId = old.providerEventId;
    }
    try {
      const r = await this.calendar.provider.upsert(ev);
      return { kind: 'accepted', receipt: { providerEventId: r.providerEventId, deliveryStatus: 'confirmed', evidence: 'calendar provider stored the event' } };
    } catch (e) {
      return { kind: 'ambiguous', error: (e as Error).message };
    }
  }

  async reconcile(intent: ActionIntent<CalendarActionPayload>) {
    const found = await this.calendar.provider.findByIdempotencyKey(intent.idempotencyKey);
    if (!found) return { found: false as const };
    return { found: true as const, receipt: { providerEventId: found.providerEventId, deliveryStatus: 'confirmed' as const, evidence: 'found during reconciliation' } };
  }
}
