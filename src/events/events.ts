import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Channel, type Space, JenniferError } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';

/** Common envelope for every inbound event (spec §5). */
export interface EventEnvelope {
  eventId: string;
  providerEventId: string;
  ownerId: string;
  accountId: string;
  channel: Channel;
  conversationId?: string;
  sender?: { displayName?: string; address: string };
  occurredAt: Date;
  receivedAt: Date;
  payloadRef: string; // pointer to encrypted object storage; payload never inlined in logs
  language?: string;
  space?: Space;
  traceId: string;
  kind: 'message.received' | 'message.sent' | 'calendar.changed' | 'call.incoming' | 'connector.health' | 'sync.gap';
}

export type NewEvent = Omit<EventEnvelope, 'eventId' | 'receivedAt' | 'traceId'> & { traceId?: string };

/**
 * Verify an HMAC-SHA256 webhook signature over `${timestamp}.${body}` with a
 * freshness window, before any event is accepted (spec §5). Provider-specific
 * adapters (Google Pub/Sub JWT, Graph clientState, Twilio signature) map onto
 * this contract or implement their own verifier.
 */
export function verifyWebhookSignature(opts: {
  secret: string;
  body: string;
  timestamp: string;
  signature: string;
  now: Date;
  toleranceSeconds?: number;
}): void {
  const ts = Number(opts.timestamp);
  if (!Number.isFinite(ts)) throw new JenniferError('webhook.bad_timestamp', 'Missing or invalid webhook timestamp');
  const skew = Math.abs(opts.now.getTime() / 1000 - ts);
  if (skew > (opts.toleranceSeconds ?? 300)) throw new JenniferError('webhook.stale', 'Webhook timestamp outside tolerance');
  const expected = signWebhook(opts.secret, opts.timestamp, opts.body);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(opts.signature.replace(/^sha256=/, ''), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new JenniferError('webhook.bad_signature', 'Webhook signature mismatch');
}

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Durable event log port: in-memory for unit tests, Postgres in production. */
export interface EventLog {
  ingest(input: NewEvent): Promise<{ event: EventEnvelope; duplicate: boolean }>;
  claim(max?: number): Promise<EventEnvelope[]>;
  markProcessed(eventId: string): Promise<void>;
  requeue(eventId: string): Promise<void>;
}

/**
 * In-memory event store. The unique (accountId, providerEventId) constraint
 * deduplicates redelivered webhooks; the event is committed before the
 * receipt is acknowledged, then processed asynchronously.
 */
export class EventStore implements EventLog {
  private events = new Map<string, EventEnvelope>();
  private byProviderKey = new Map<string, string>();
  private pending: string[] = [];
  private processed = new Set<string>();

  constructor(private clock: Clock) {}

  async ingest(input: NewEvent): Promise<{ event: EventEnvelope; duplicate: boolean }> {
    const key = `${input.accountId}:${input.providerEventId}`;
    const existingId = this.byProviderKey.get(key);
    if (existingId) return { event: this.events.get(existingId)!, duplicate: true };
    const event: EventEnvelope = { ...input, eventId: newId('evt'), receivedAt: this.clock.now(), traceId: input.traceId ?? newId('trace') };
    this.events.set(event.eventId, event);
    this.byProviderKey.set(key, event.eventId);
    this.pending.push(event.eventId);
    return { event, duplicate: false };
  }

  /** Claim the next unprocessed events (worker side). */
  async claim(max = 50): Promise<EventEnvelope[]> {
    const ids = this.pending.splice(0, max);
    return ids.map((id) => this.events.get(id)!);
  }

  async markProcessed(eventId: string): Promise<void> {
    this.processed.add(eventId);
  }

  /** Put an event back for retry after a transient processing failure. */
  async requeue(eventId: string): Promise<void> {
    if (!this.processed.has(eventId)) this.pending.push(eventId);
  }

  get(eventId: string): EventEnvelope | undefined {
    return this.events.get(eventId);
  }

  all(): EventEnvelope[] {
    return [...this.events.values()];
  }
}

export interface DeadLetter {
  id: string;
  subjectId: string;
  kind: string;
  error: string;
  attempts: number;
  at: Date;
  recoveryAction: string;
}

/** Repeated failures land here with a visible recovery action (spec §5). */
export class DeadLetterQueue {
  private items: DeadLetter[] = [];
  constructor(private clock: Clock) {}
  push(d: Omit<DeadLetter, 'id' | 'at'>): DeadLetter {
    const item = { ...d, id: newId('dlq'), at: this.clock.now() };
    this.items.push(item);
    return item;
  }
  list(): DeadLetter[] {
    return [...this.items];
  }
  remove(id: string): void {
    this.items = this.items.filter((i) => i.id !== id);
  }
}
