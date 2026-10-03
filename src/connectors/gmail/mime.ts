import { simpleParser, type AddressObject } from 'mailparser';
import { createHash } from 'node:crypto';
import { sanitizeForModel } from '../../security/untrusted.js';

/**
 * RFC 5322 / MIME parsing for inbound mail (spec §6): keeps subject, thread
 * identifiers, reply headers, recipients, CC, quoted content and attachment
 * metadata. Attachment bytes are never handed to a model; only metadata.
 */
export interface ParsedEmail {
  messageId?: string; // RFC Message-ID, without angle brackets
  inReplyTo?: string;
  references: string[];
  from: { displayName?: string; address: string };
  replyTo?: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  date?: Date;
  headers: Record<string, string>;
  attachments: Array<{ filename: string; contentType: string; size: number; sha256: string }>;
}

/** Headers kept for threading, loop protection and spoofing analysis. */
const KEPT_HEADERS = [
  'message-id',
  'in-reply-to',
  'references',
  'list-id',
  'list-unsubscribe',
  'precedence',
  'auto-submitted',
  'x-autoreply',
  'x-autorespond',
  'content-type',
  'authentication-results',
  'return-path',
  'reply-to',
];

const strip = (id: string) => id.trim().replace(/^<|>$/g, '');

function addresses(a: AddressObject | AddressObject[] | undefined): Array<{ name?: string; address: string }> {
  if (!a) return [];
  return (Array.isArray(a) ? a : [a]).flatMap((o) => o.value).filter((v) => !!v.address).map((v) => ({ name: v.name || undefined, address: v.address!.toLowerCase() }));
}

export async function parseRawEmail(raw: Buffer | string): Promise<ParsedEmail> {
  const m = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
  const headers: Record<string, string> = {};
  for (const k of KEPT_HEADERS) {
    const v = m.headers.get(k);
    if (v === undefined) continue;
    headers[k] = typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : typeof v === 'object' && v && 'value' in v ? String((v as { value: unknown }).value) : String(v);
  }
  const from = addresses(m.from)[0] ?? { address: 'unknown@invalid' };
  const refs = Array.isArray(m.references) ? m.references : m.references ? [m.references] : [];
  const text = m.text?.trim() ? m.text : m.html ? sanitizeForModel(m.html) : '';
  return {
    messageId: m.messageId ? strip(m.messageId) : undefined,
    inReplyTo: m.inReplyTo ? strip(m.inReplyTo) : undefined,
    references: refs.flatMap((r) => r.split(/\s+/)).filter(Boolean).map(strip),
    from: { displayName: from.name, address: from.address },
    replyTo: addresses(m.replyTo)[0]?.address,
    to: addresses(m.to).map((x) => x.address),
    cc: addresses(m.cc).map((x) => x.address),
    subject: m.subject ?? '',
    text,
    date: m.date,
    headers,
    attachments: m.attachments.map((a) => ({
      filename: a.filename ?? 'attachment',
      contentType: a.contentType,
      size: a.size,
      sha256: createHash('sha256').update(a.content).digest('hex'),
    })),
  };
}

/**
 * Stable thread key. Real Gmail provides X-GM-THRID; otherwise use the root
 * of the References chain (RFC 5256 style), then In-Reply-To, then the
 * message's own id.
 */
export function threadKey(p: ParsedEmail, gmailThreadId?: string): string {
  if (gmailThreadId) return `gm:${gmailThreadId}`;
  const root = p.references[0] ?? p.inReplyTo ?? p.messageId;
  return root ? `mid:${root}` : `subj:${p.subject.replace(/^(re|fw|fwd|r|aw|enc):\s*/i, '').toLowerCase()}`;
}

/** Stable provider message id across UIDVALIDITY resets. */
export function providerMessageId(p: ParsedEmail, gmailMessageId: string | undefined, fallback: string): string {
  if (gmailMessageId) return `gm:${gmailMessageId}`;
  if (p.messageId) return `mid:${p.messageId}`;
  return fallback;
}
