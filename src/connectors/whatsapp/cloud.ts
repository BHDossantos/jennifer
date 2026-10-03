import { createHmac, timingSafeEqual } from 'node:crypto';
import { redactSecrets } from '../../security/redaction.js';
import type { MessagingConnector, OutboundMessage, SendResult } from '../connector.js';

/**
 * Bruno's WhatsApp Business number through Meta's official WhatsApp Cloud
 * API. With "coexistence" onboarding he keeps using the WhatsApp Business
 * app on his phone while Jennifer reads and replies through the API; the
 * messages he types in the app arrive as `smb_message_echoes`.
 *
 * Rules enforced here rather than left to the model (spec §7): free-form
 * replies only inside the 24-hour customer-service window after the
 * customer's last message; outside it Meta requires an approved template.
 */
export interface WhatsAppConfig {
  token: string; // system-user access token
  phoneNumberId: string;
  appSecret: string; // verifies webhook signatures
  graphVersion?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const WINDOW_MS = 24 * 3600_000;
export const toE164 = (waId: string) => (waId.startsWith('+') ? waId : `+${waId}`);
const toWaId = (addr: string) => addr.replace(/[^\d]/g, '');

export class WhatsAppCloud implements MessagingConnector {
  readonly id = 'whatsapp_business';
  readonly reconcileGraceMs = 120_000;
  /** Last inbound message time per customer (E.164): the service window. */
  private lastInbound = new Map<string, number>();
  /** idempotency key → WhatsApp message id, learned from status webhooks. */
  private confirmed = new Map<string, string>();

  constructor(private c: WhatsAppConfig) {}

  get accountId(): string {
    return `whatsapp:${this.c.phoneNumberId}`;
  }

  private now(): number {
    return (this.c.now ?? Date.now)();
  }

  noteInbound(addressE164: string, at: number): void {
    const prev = this.lastInbound.get(addressE164) ?? 0;
    if (at > prev) this.lastInbound.set(addressE164, at);
  }

  noteStatus(key: string | undefined, messageId: string): void {
    if (key) this.confirmed.set(key, messageId);
    if (this.confirmed.size > 5000) this.confirmed.delete(this.confirmed.keys().next().value!);
  }

  windowOpen(addressE164: string): boolean {
    const t = this.lastInbound.get(addressE164);
    return t !== undefined && this.now() - t < WINDOW_MS;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (msg.to.length !== 1 || msg.cc.length || msg.bcc.length) return { kind: 'rejected', error: 'WhatsApp messages go to one person', retryable: false };
    if (msg.attachments.length) return { kind: 'rejected', error: 'WhatsApp attachments are not supported yet', retryable: false };
    const to = toE164(toWaId(msg.to[0]!));
    if (!this.windowOpen(to))
      return { kind: 'rejected', error: 'WhatsApp only allows free-form replies within 24 hours of the customer\'s last message; outside that window an approved template is required', retryable: false };
    let res: Response;
    try {
      res = await (this.c.fetchImpl ?? fetch)(`https://graph.facebook.com/${this.c.graphVersion ?? 'v21.0'}/${this.c.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.c.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toWaId(to),
          type: 'text',
          text: { body: msg.body, preview_url: false },
          // Echoed back on status webhooks: lets a timed-out send be reconciled instead of repeated.
          biz_opaque_callback_data: msg.idempotencyKey,
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { kind: 'timeout' };
    }
    if (res.status >= 500) return { kind: 'timeout' };
    const json = (await res.json().catch(() => ({}))) as { messages?: Array<{ id: string }>; error?: { message?: string; code?: number } };
    if (!res.ok) {
      const unauthorized = res.status === 401 || json.error?.code === 190;
      return { kind: 'rejected', error: `${unauthorized ? 'unauthorized: ' : ''}WhatsApp ${res.status}: ${redactSecrets(json.error?.message ?? '')}`, retryable: res.status === 429 };
    }
    const id = json.messages?.[0]?.id ?? `key:${msg.idempotencyKey}`;
    this.noteStatus(msg.idempotencyKey, id);
    return { kind: 'accepted', providerMessageId: id, deliveryStatus: 'accepted' };
  }

  async findByIdempotencyKey(_accountId: string, key: string): Promise<{ providerMessageId: string } | undefined> {
    const id = this.confirmed.get(key);
    return id ? { providerMessageId: id } : undefined;
  }
}

/** Meta signs webhook bodies: X-Hub-Signature-256: sha256=<hex HMAC of the raw body with the app secret>. */
export function verifyMetaSignature(appSecret: string, rawBody: string, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex'));
  const got = Buffer.from(header.slice(7));
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export interface WhatsAppWebhookValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
  messages?: Array<{ id: string; from: string; timestamp: string; type: string; text?: { body: string } }>;
  statuses?: Array<{ id: string; status: string; recipient_id: string; biz_opaque_callback_data?: string }>;
  /** Coexistence: messages Bruno sent from the WhatsApp Business app. */
  message_echoes?: Array<{ id: string; from: string; to: string; timestamp: string; type: string; text?: { body: string } }>;
}
