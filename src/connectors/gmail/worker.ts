import type { ImapFlow } from 'imapflow';
import type { Space } from '../../core/types.js';
import { type Clock, backoffDelayMs } from '../../core/util.js';
import type { Db } from '../../db/db.js';
import type { InboundEmail } from '../../assistant/inbound.js';
import { ImapMailbox, MailAuthError, type SyncCursor, type SyncedEmail } from './imap.js';

export interface CursorStore {
  get(connectorId: string, accountId: string): Promise<SyncCursor | undefined>;
  put(connectorId: string, accountId: string, cursor: SyncCursor): Promise<void>;
}

export class MemoryCursorStore implements CursorStore {
  private m = new Map<string, SyncCursor>();
  async get(c: string, a: string) {
    return this.m.get(`${c}:${a}`);
  }
  async put(c: string, a: string, cur: SyncCursor) {
    this.m.set(`${c}:${a}`, cur);
  }
}

export class PgCursorStore implements CursorStore {
  constructor(
    private db: Db,
    private ownerId: string,
  ) {}
  async get(connectorId: string, accountId: string) {
    const r = await this.db.query<{ cursor: SyncCursor }>('SELECT cursor FROM connector_cursor WHERE owner_id = $1 AND connector_id = $2 AND account_id = $3', [this.ownerId, connectorId, accountId]);
    return r.rows[0]?.cursor;
  }
  async put(connectorId: string, accountId: string, cursor: SyncCursor) {
    await this.db.query(
      `INSERT INTO connector_cursor (owner_id, connector_id, account_id, cursor, updated_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (owner_id, connector_id, account_id) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
      [this.ownerId, connectorId, accountId, JSON.stringify(cursor)],
    );
  }
}

export type WorkerStatus = { state: 'connecting' | 'idle' | 'syncing' | 'backoff' | 'stopped'; detail?: string } | { state: 'auth_failed'; detail: string };

export interface MailboxWorkerOptions {
  mailbox: ImapMailbox;
  connectorId: string;
  accountId: string;
  space: Space;
  cursors: CursorStore;
  clock: Clock;
  /** Called for each new message; must be idempotent (the event store dedups). */
  onEmail: (email: InboundEmail) => Promise<void>;
  onStatus?: (s: WorkerStatus) => void;
  onSynced?: () => void;
  /** Safety-net full poll even when IDLE is healthy (spec §5: notifications can be missed). */
  pollIntervalMs?: number;
}

/** Map a synced IMAP message onto Jennifer's inbound envelope. */
export function toInbound(e: SyncedEmail, o: { accountId: string; connectorId: string; space: Space; clock: Clock }): InboundEmail {
  const p = e.parsed;
  const headers = { ...p.headers };
  if (p.messageId) headers['message-id'] = p.messageId;
  return {
    accountId: o.accountId,
    connectorId: o.connectorId,
    providerMessageId: e.providerMessageId,
    providerThreadId: e.providerThreadId,
    from: p.from,
    to: p.to,
    cc: p.cc,
    subject: p.subject,
    body: p.text,
    headers,
    occurredAt: e.internalDate ?? p.date ?? o.clock.now(),
    space: o.space,
    attachmentMeta: p.attachments.map((a, i) => ({ filename: a.filename, contentType: a.contentType, size: a.size, storageRef: `${o.connectorId}:${e.providerMessageId}:att${i}:${a.sha256}` })),
  };
}

/**
 * Keeps one IMAP connection open on INBOX. New mail arrives via IDLE
 * ("exists"); a periodic poll and reconnect-with-catch-up cover dropped
 * notifications. The cursor is saved only after messages are handed off,
 * so a crash re-delivers (deduplicated) rather than losing mail.
 */
export class MailboxWorker {
  private client?: ImapFlow;
  private running = false;
  private syncing: Promise<void> = Promise.resolve();
  private pending = false;
  private attempt = 0;
  private pollTimer?: NodeJS.Timeout;
  private wake?: () => void;

  constructor(private o: MailboxWorkerOptions) {}

  /** One catch-up sync on a short-lived connection (also used by tests and manual "check now"). */
  async syncOnce(client?: ImapFlow): Promise<number> {
    this.o.onStatus?.({ state: 'syncing' });
    const cursor = await this.o.cursors.get(this.o.connectorId, this.o.accountId);
    const r = await this.o.mailbox.sync(cursor, { client });
    for (const e of r.emails) await this.o.onEmail(toInbound(e, this.o));
    await this.o.cursors.put(this.o.connectorId, this.o.accountId, r.cursor);
    this.o.onSynced?.();
    this.o.onStatus?.({ state: 'idle' });
    return r.emails.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.pollTimer);
    this.wake?.();
    await this.client?.logout().catch(() => {});
    await this.syncing.catch(() => {});
    this.o.onStatus?.({ state: 'stopped' });
  }

  /** Coalesce bursts of notifications into serialized syncs. */
  private requestSync(): void {
    if (this.pending) return;
    this.pending = true;
    this.syncing = this.syncing.then(async () => {
      this.pending = false;
      if (this.running && this.client?.usable) await this.syncOnce(this.client);
    });
    this.syncing.catch(() => {});
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        this.o.onStatus?.({ state: 'connecting' });
        const c = await this.o.mailbox.open();
        this.client = c;
        const closed = new Promise<void>((resolve) => {
          c.on('close', () => resolve());
          this.wake = resolve;
        });
        await c.mailboxOpen('INBOX');
        await this.syncOnce(c);
        this.attempt = 0;
        c.on('exists', () => this.requestSync());
        this.pollTimer = setInterval(() => this.requestSync(), this.o.pollIntervalMs ?? 5 * 60_000);
        await closed; // imapflow keeps IDLE running while the mailbox is selected
        clearInterval(this.pollTimer);
      } catch (e) {
        if (e instanceof MailAuthError) {
          this.running = false;
          this.o.onStatus?.({ state: 'auth_failed', detail: e.message });
          return;
        }
      }
      if (!this.running) break;
      const delay = backoffDelayMs(this.attempt++, 1000, 5 * 60_000);
      this.o.onStatus?.({ state: 'backoff', detail: `reconnecting in ${Math.round(delay / 1000)}s` });
      await new Promise<void>((r) => {
        const t = setTimeout(r, delay);
        this.wake = () => {
          clearTimeout(t);
          r();
        };
      });
    }
  }
}
