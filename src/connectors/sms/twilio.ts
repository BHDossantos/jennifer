import { createHmac, timingSafeEqual } from 'node:crypto';
import { redactSecrets } from '../../security/redaction.js';
import type { MessagingConnector, OutboundMessage, SendResult } from '../connector.js';

/**
 * SMS on Jennifer's own number through a Twilio-compatible REST API
 * (Twilio, or SignalWire's LaML API with `apiBase`). Bruno's AT&T number is
 * never touched: forwarding moves calls only, so texts reach Jennifer only
 * when people text her number (spec §7).
 */
export interface SmsConfig {
  accountSid: string;
  authToken: string;
  from: string; // E.164, Jennifer's number
  /** https://api.twilio.com (default) or https://<space>.signalwire.com/api/laml */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

const E164 = /^\+\d{8,15}$/;

export class TwilioSms implements MessagingConnector {
  readonly id = 'sms';
  readonly reconcileGraceMs = 60_000;
  /** Recent sends by idempotency key, for reconciliation after a timeout. */
  private attempts = new Map<string, { to: string; body: string; at: number }>();

  constructor(private c: SmsConfig) {}

  get accountId(): string {
    return `sms:${this.c.from}`;
  }

  private base(): string {
    return `${this.c.apiBase ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${encodeURIComponent(this.c.accountSid)}`;
  }

  private auth(): string {
    return `Basic ${Buffer.from(`${this.c.accountSid}:${this.c.authToken}`).toString('base64')}`;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (msg.to.length !== 1 || msg.cc.length || msg.bcc.length) return { kind: 'rejected', error: 'SMS goes to exactly one number', retryable: false };
    const to = msg.to[0]!;
    if (!E164.test(to)) return { kind: 'rejected', error: `${to} is not an international (E.164) phone number`, retryable: false };
    if (msg.attachments.length) return { kind: 'rejected', error: 'SMS cannot carry attachments', retryable: false };
    this.attempts.set(msg.idempotencyKey, { to, body: msg.body, at: Date.now() });
    if (this.attempts.size > 1000) this.attempts.delete(this.attempts.keys().next().value!);
    let res: Response;
    try {
      res = await (this.c.fetchImpl ?? fetch)(`${this.base()}/Messages.json`, {
        method: 'POST',
        headers: { authorization: this.auth(), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: this.c.from, Body: msg.body }).toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { kind: 'timeout' }; // may have been accepted: reconcile before any retry
    }
    if (res.status >= 500) return { kind: 'timeout' };
    const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; message?: string; code?: number };
    if (!res.ok) {
      const unauthorized = res.status === 401 || res.status === 403;
      return { kind: 'rejected', error: `${unauthorized ? 'unauthorized: ' : ''}SMS ${res.status}: ${redactSecrets(json.message ?? '')}`, retryable: res.status === 429 };
    }
    return { kind: 'accepted', providerMessageId: json.sid ?? 'unknown', deliveryStatus: json.status === 'delivered' ? 'delivered' : 'accepted' };
  }

  /** Twilio has no idempotency keys: look for the same text to the same number sent since the attempt. */
  async findByIdempotencyKey(_accountId: string, key: string): Promise<{ providerMessageId: string } | undefined> {
    const a = this.attempts.get(key);
    if (!a) return undefined;
    const since = new Date(a.at - 60_000).toISOString().slice(0, 10);
    const q = new URLSearchParams({ To: a.to, From: this.c.from, 'DateSent>': since, PageSize: '50' });
    const res = await (this.c.fetchImpl ?? fetch)(`${this.base()}/Messages.json?${q}`, { headers: { authorization: this.auth() } });
    if (!res.ok) throw new Error(`SMS lookup failed (${res.status})`);
    const json = (await res.json()) as { messages?: Array<{ sid: string; body: string; date_created?: string }> };
    const hit = (json.messages ?? []).find((m) => m.body === a.body && (!m.date_created || Date.parse(m.date_created) >= a.at - 60_000));
    return hit ? { providerMessageId: hit.sid } : undefined;
  }

  /** Send a plain alert to Bruno's own phone (notification fallback channel). Not an ActionIntent: it only ever goes to Bruno. */
  async alertOwner(to: string, body: string): Promise<void> {
    if (!E164.test(to)) throw new Error('alert number must be E.164');
    const res = await (this.c.fetchImpl ?? fetch)(`${this.base()}/Messages.json`, {
      method: 'POST',
      headers: { authorization: this.auth(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: this.c.from, Body: body.slice(0, 600) }).toString(),
    });
    if (!res.ok) throw new Error(`SMS alert failed (${res.status})`);
  }
}

/**
 * Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted
 * key/value pairs)). SignalWire's LaML webhooks use the same scheme.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(signature);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
