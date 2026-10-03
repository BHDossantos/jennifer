import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { JenniferError } from '../../core/types.js';
import { parseRawEmail, providerMessageId, threadKey, type ParsedEmail } from './mime.js';

/**
 * Gmail over IMAP with an app password (no Google Cloud project needed).
 *
 * Sync is cursor based, the IMAP equivalent of Gmail's history id:
 * (UIDVALIDITY, last UID). A UIDVALIDITY change triggers a bounded resync
 * whose duplicates are absorbed by the event store's unique key.
 */
export interface MailServer {
  host: string;
  port: number;
  secure: boolean;
  /** Only for local test servers. Never disabled against Gmail. */
  allowSelfSigned?: boolean;
}

export interface MailCredentials {
  address: string;
  password: string; // Google app password (16 chars), from the vault
}

export const GMAIL_IMAP: MailServer = { host: 'imap.gmail.com', port: 993, secure: true };
export const GMAIL_SMTP: MailServer = { host: 'smtp.gmail.com', port: 465, secure: true };

export interface SyncCursor {
  uidValidity: string;
  lastUid: number;
}

export interface SyncedEmail {
  uid: number;
  providerMessageId: string;
  providerThreadId: string;
  parsed: ParsedEmail;
  labels: string[];
  internalDate?: Date;
}

export class MailAuthError extends JenniferError {
  constructor(message: string) {
    super('mail.auth_failed', message);
  }
}

/** Max raw size Jennifer will download for analysis; larger messages keep headers only. */
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

export class ImapMailbox {
  constructor(
    private server: MailServer,
    private creds: MailCredentials,
  ) {}

  client(): ImapFlow {
    return new ImapFlow({
      host: this.server.host,
      port: this.server.port,
      secure: this.server.secure,
      auth: { user: this.creds.address, pass: this.creds.password },
      logger: false,
      tls: this.server.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
      emitLogs: false,
      // Enter IDLE (push) one second after the connection goes quiet instead of imapflow's 15 s default.
      autoIdleDelay: 1000,
    } as ConstructorParameters<typeof ImapFlow>[0]);
  }

  /** Connect, mapping authentication failures to a typed error (→ connector disconnected). */
  async open(): Promise<ImapFlow> {
    const c = this.client();
    c.on('error', () => {}); // surfaced through awaited calls; avoid unhandled 'error' events
    try {
      await c.connect();
    } catch (e) {
      const err = e as { authenticationFailed?: boolean; responseText?: string; message?: string };
      if (err.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(`${err.responseText ?? ''} ${err.message ?? ''}`))
        throw new MailAuthError('Gmail rejected the app password (revoked, changed, or 2-Step Verification turned off)');
      throw e;
    }
    return c;
  }

  /** Verify credentials and mailbox access (used by the connect flow). */
  async verify(): Promise<{ inboxMessages: number }> {
    const c = await this.open();
    try {
      const s = await c.status('INBOX', { messages: true });
      return { inboxMessages: s ? (s.messages ?? 0) : 0 };
    } finally {
      await c.logout().catch(() => {});
    }
  }

  /**
   * Fetch everything after the cursor. With no cursor, start from "now"
   * (history import is a separate, explicit action).
   */
  async sync(cursor: SyncCursor | undefined, opts: { client?: ImapFlow; resyncDays?: number; mailbox?: string } = {}): Promise<{ emails: SyncedEmail[]; cursor: SyncCursor; resynced: boolean }> {
    const c = opts.client ?? (await this.open());
    const lock = await c.getMailboxLock(opts.mailbox ?? 'INBOX');
    try {
      const mb = c.mailbox;
      if (!mb) throw new Error('mailbox not selected');
      const uidValidity = String(mb.uidValidity);
      const uidNext = Number(mb.uidNext ?? 1);
      if (!cursor) return { emails: [], cursor: { uidValidity, lastUid: uidNext - 1 }, resynced: false };

      let range: string | { since: Date };
      let resynced = false;
      if (cursor.uidValidity !== uidValidity) {
        resynced = true;
        range = { since: new Date(Date.now() - (opts.resyncDays ?? 7) * 24 * 3600_000) };
      } else {
        // Don't trust the cached UIDNEXT: on a long-lived (IDLE) connection it is stale after EXISTS.
        range = `${cursor.lastUid + 1}:*`;
      }

      const emails: SyncedEmail[] = [];
      let maxUid = resynced ? 0 : cursor.lastUid;
      const query = { uid: true, envelope: true, size: true, internalDate: true, emailId: true, threadId: true, labels: true, source: true } as const;
      const iter = typeof range === 'string' ? c.fetch(range, query, { uid: true }) : c.fetch(range, query);
      for await (const m of iter as AsyncIterable<FetchMessageObject>) {
        if (!resynced && m.uid <= cursor.lastUid) continue; // "n:*" returns the last message when nothing is new
        maxUid = Math.max(maxUid, m.uid);
        const raw = m.source && (m.size ?? 0) <= MAX_SOURCE_BYTES ? m.source : Buffer.from(`Subject: ${m.envelope?.subject ?? ''}\r\n\r\n[message too large to analyze]`);
        const parsed = await parseRawEmail(raw);
        emails.push({
          uid: m.uid,
          providerMessageId: providerMessageId(parsed, m.emailId, `uid:${uidValidity}:${m.uid}`),
          providerThreadId: threadKey(parsed, m.threadId),
          parsed,
          labels: [...(m.labels ?? [])],
          internalDate: m.internalDate ? new Date(m.internalDate) : undefined,
        });
      }
      return { emails, cursor: { uidValidity, lastUid: Math.max(maxUid, resynced ? uidNext - 1 : cursor.lastUid) }, resynced };
    } finally {
      lock.release();
      if (!opts.client) await c.logout().catch(() => {});
    }
  }

  /** Explicit history import: messages received in the last `days` (bounded). Does not move the cursor. */
  async history(days: number, max = 500): Promise<SyncedEmail[]> {
    const c = await this.open();
    const lock = await c.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - days * 24 * 3600_000);
      const uids = ((await c.search({ since }, { uid: true })) || []) as number[];
      const pick = uids.slice(-max);
      if (pick.length === 0) return [];
      const uidValidity = String(c.mailbox ? c.mailbox.uidValidity : '0');
      const out: SyncedEmail[] = [];
      const query = { uid: true, envelope: true, size: true, internalDate: true, emailId: true, threadId: true, labels: true, source: true } as const;
      for await (const m of c.fetch(pick.join(','), query, { uid: true }) as AsyncIterable<FetchMessageObject>) {
        const raw = m.source && (m.size ?? 0) <= MAX_SOURCE_BYTES ? m.source : Buffer.from(`Subject: ${m.envelope?.subject ?? ''}\r\n\r\n[message too large to analyze]`);
        const parsed = await parseRawEmail(raw);
        out.push({
          uid: m.uid,
          providerMessageId: providerMessageId(parsed, m.emailId, `uid:${uidValidity}:${m.uid}`),
          providerThreadId: threadKey(parsed, m.threadId),
          parsed,
          labels: [...(m.labels ?? [])],
          internalDate: m.internalDate ? new Date(m.internalDate) : undefined,
        });
      }
      return out;
    } finally {
      lock.release();
      await c.logout().catch(() => {});
    }
  }

  /** Reconciliation: does the Sent folder contain our Message-ID? */
  async findSent(messageId: string): Promise<boolean> {
    const c = await this.open();
    try {
      const sent = (await c.list()).find((b) => b.specialUse === '\\Sent');
      if (!sent) throw new Error('No Sent mailbox advertised');
      const lock = await c.getMailboxLock(sent.path);
      try {
        const uids = await c.search({ header: { 'message-id': messageId } }, { uid: true });
        return Array.isArray(uids) && uids.length > 0;
      } finally {
        lock.release();
      }
    } finally {
      await c.logout().catch(() => {});
    }
  }

  /** Place a draft in Gmail's Drafts folder (draft mode: Bruno sends it himself). */
  async appendDraft(raw: Buffer): Promise<{ uid?: number }> {
    const c = await this.open();
    try {
      const drafts = (await c.list()).find((b) => b.specialUse === '\\Drafts');
      if (!drafts) throw new Error('No Drafts mailbox advertised');
      const r = await c.append(drafts.path, raw, ['\\Draft', '\\Seen']);
      return { uid: r && typeof r === 'object' && 'uid' in r ? (r.uid as number) : undefined };
    } finally {
      await c.logout().catch(() => {});
    }
  }
}
