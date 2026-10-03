import { timingSafeEqual } from 'node:crypto';
import { redactSecrets } from '../../security/redaction.js';
import type { MessagingConnector, OutboundMessage, SendResult } from '../connector.js';

/**
 * Bruno's own iMessage (and SMS through his iPhone's Text Message
 * Forwarding) via BlueBubbles Server running on his Mac, signed in with his
 * Apple ID. Jennifer talks to the Mac's REST API; the Mac posts new
 * messages to Jennifer's webhook. Nothing is scraped and no Apple password
 * reaches Jennifer: the Mac stays the only device signed in.
 * https://bluebubbles.app — REST API /api/v1, password in the query string.
 */
export interface BlueBubblesConfig {
  url: string; // e.g. https://bruno-mac.trycloudflare.com (BlueBubbles' built-in Cloudflare tunnel)
  password: string;
  /** 'apple-script' works without extra setup; 'private-api' is faster if enabled on the Mac. */
  method?: 'apple-script' | 'private-api';
  fetchImpl?: typeof fetch;
}

export interface BlueBubblesMessage {
  guid: string;
  text: string | null;
  isFromMe: boolean;
  dateCreated: number; // ms epoch
  handle?: { address: string } | null;
  chats?: Array<{ guid: string; displayName?: string; participants?: Array<{ address: string }> }>;
  attachments?: Array<{ transferName?: string; mimeType?: string; totalBytes?: number }>;
  tempGuid?: string | null;
}

export class BlueBubblesIMessage implements MessagingConnector {
  readonly id = 'imessage';
  readonly reconcileGraceMs = 60_000;
  private attempts = new Map<string, { chatGuid: string; text: string; at: number }>();
  /** Recent texts Jennifer sent, so the Mac's echo of them is not mistaken for Bruno typing. */
  private recentOwn: Array<{ chatGuid: string; text: string; at: number }> = [];

  constructor(private c: BlueBubblesConfig) {}

  readonly accountId = 'imessage:bruno';

  /** Direct chat GUID for a phone number or Apple ID email. "any" lets the Mac choose iMessage or SMS. */
  static chatGuidFor(address: string): string {
    return `any;-;${address}`;
  }

  private url(path: string, q: Record<string, string> = {}): string {
    const u = new URL(`${this.c.url.replace(/\/$/, '')}/api/v1${path}`);
    u.searchParams.set('password', this.c.password);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u.toString();
  }

  async ping(): Promise<boolean> {
    const res = await (this.c.fetchImpl ?? fetch)(this.url('/ping'), { signal: AbortSignal.timeout(10_000) });
    return res.ok;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (msg.to.length !== 1 || msg.cc.length || msg.bcc.length) return { kind: 'rejected', error: 'Jennifer sends iMessages to one person at a time', retryable: false };
    if (msg.attachments.length) return { kind: 'rejected', error: 'iMessage attachments are not supported yet', retryable: false };
    const chatGuid = msg.providerThreadId?.startsWith('imessage:') ? msg.providerThreadId.slice('imessage:'.length) : BlueBubblesIMessage.chatGuidFor(msg.to[0]!);
    this.attempts.set(msg.idempotencyKey, { chatGuid, text: msg.body, at: Date.now() });
    if (this.attempts.size > 1000) this.attempts.delete(this.attempts.keys().next().value!);
    this.recentOwn.push({ chatGuid, text: msg.body, at: Date.now() });
    this.recentOwn = this.recentOwn.filter((r) => Date.now() - r.at < 10 * 60_000);
    let res: Response;
    try {
      res = await (this.c.fetchImpl ?? fetch)(this.url('/message/text'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatGuid, tempGuid: msg.idempotencyKey, message: msg.body, method: this.c.method ?? 'apple-script' }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return { kind: 'timeout' }; // the Mac may have sent it: reconcile first
    }
    if (res.status >= 500) return { kind: 'timeout' };
    const json = (await res.json().catch(() => ({}))) as { status?: number; message?: string; data?: { guid?: string } };
    if (!res.ok) return { kind: 'rejected', error: `${res.status === 401 ? 'unauthorized: ' : ''}iMessage ${res.status}: ${redactSecrets(json.message ?? '')}`, retryable: false };
    return { kind: 'accepted', providerMessageId: json.data?.guid ?? `temp:${msg.idempotencyKey}`, deliveryStatus: 'accepted' };
  }

  async findByIdempotencyKey(_accountId: string, key: string): Promise<{ providerMessageId: string } | undefined> {
    const a = this.attempts.get(key);
    if (!a) return undefined;
    const res = await (this.c.fetchImpl ?? fetch)(this.url(`/chat/${encodeURIComponent(a.chatGuid)}/message`, { limit: '25', sort: 'DESC' }));
    if (!res.ok) throw new Error(`iMessage lookup failed (${res.status})`);
    const json = (await res.json()) as { data?: BlueBubblesMessage[] };
    const hit = (json.data ?? []).find((m) => m.isFromMe && m.text === a.text && m.dateCreated >= a.at - 60_000);
    return hit ? { providerMessageId: hit.guid } : undefined;
  }

  /** True when an outgoing message seen on the Mac is one Jennifer just sent. */
  isOwnEcho(chatGuid: string, text: string): boolean {
    const now = Date.now();
    const i = this.recentOwn.findIndex((r) => r.text === text && now - r.at < 10 * 60_000 && (r.chatGuid === chatGuid || r.chatGuid.split(';-;')[1] === chatGuid.split(';-;')[1]));
    if (i < 0) return false;
    this.recentOwn.splice(i, 1);
    return true;
  }
}

/** The webhook URL carries a secret token (BlueBubbles does not sign webhooks). */
export function verifyWebhookToken(expected: string, got: string | undefined): boolean {
  if (!got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}
