import { JenniferError, type Space } from '../../core/types.js';
import type { Clock } from '../../core/util.js';
import type { Db } from '../../db/db.js';
import type { Vault } from '../../identity/vault.js';
import type { AuditLog } from '../../audit/audit.js';
import type { CapabilityRegistry } from '../capabilities.js';
import type { InboundEmail } from '../../assistant/inbound.js';
import { GmailConnector } from './gmailConnector.js';
import { GMAIL_IMAP, GMAIL_SMTP, ImapMailbox, MailAuthError, type MailCredentials, type MailServer } from './imap.js';
import { MailboxWorker, PgCursorStore, toInbound, type WorkerStatus } from './worker.js';

export interface GmailServiceDeps {
  db: Db;
  vault: Vault;
  clock: Clock;
  audit: AuditLog;
  capabilities: CapabilityRegistry;
  ownerId: string;
  environment: string;
  /** Hand-off for new mail (InboundProcessor.handle). */
  onEmail: (email: InboundEmail) => Promise<void>;
  /** Hand-off for imported history: stored for context, never drafted for. */
  onHistory?: (email: InboundEmail) => Promise<void>;
  /** Register the send connector with the action pipeline. */
  registerConnector: (c: GmailConnector) => void;
  space?: Space;
  imap?: MailServer;
  smtp?: MailServer;
}

const CONNECTOR = 'gmail';

/**
 * Personal Gmail via an app password (Google account → Security → 2-Step
 * Verification → App passwords). No Google Cloud project is involved.
 * The password lives only in the vault, bound to this account and
 * environment; revoking it in Google disconnects Jennifer immediately.
 */
export class GmailService {
  private worker?: MailboxWorker;
  private status: WorkerStatus = { state: 'stopped' };
  private address?: string;

  constructor(private d: GmailServiceDeps) {}

  private accountId(address: string) {
    return `gmail:${address}`;
  }

  private binding(address: string) {
    return { ownerId: this.d.ownerId, accountId: this.accountId(address), environment: this.d.environment };
  }

  private creds = async (): Promise<MailCredentials> => {
    if (!this.address) throw new JenniferError('gmail.not_connected', 'Gmail is not connected');
    return JSON.parse(await this.d.vault.get(this.accountId(this.address), this.binding(this.address))) as MailCredentials;
  };

  async connect(addressInput: string, appPassword: string, actor: string): Promise<{ address: string; inboxMessages: number }> {
    const address = addressInput.trim().toLowerCase();
    if (!/^[^@\s]+@(gmail|googlemail)\.com$/.test(address) && !this.d.imap) throw new JenniferError('gmail.bad_address', 'Use your @gmail.com address');
    const password = appPassword.replace(/\s+/g, '');
    if (!/^[a-z]{16}$/i.test(password) && !this.d.imap) throw new JenniferError('gmail.bad_app_password', 'An app password is 16 letters (spaces are ignored)');

    let verified;
    try {
      verified = await new ImapMailbox(this.d.imap ?? GMAIL_IMAP, { address, password }).verify();
    } catch (e) {
      if (e instanceof MailAuthError) throw new JenniferError('gmail.auth_failed', e.message);
      throw e;
    }
    await this.d.vault.put(this.accountId(address), JSON.stringify({ address, password }), this.binding(address));
    await this.d.db.query(
      `INSERT INTO account_connection (id, owner_id, connector_id, environment, external_account, vault_secret_ref, scopes, capabilities, connected)
       VALUES ($1,$2,$3,$4,$5,$1,$6,$7,true)
       ON CONFLICT (id) DO UPDATE SET connected = true, revoked_at = NULL, last_error = NULL`,
      [this.accountId(address), this.d.ownerId, CONNECTOR, this.d.environment, address, ['imap', 'smtp'], JSON.stringify({ via: 'app_password' })],
    );
    this.d.audit.record(actor, 'connector.connected', this.accountId(address), { connector: CONNECTOR });
    await this.start(address);
    return { address, inboxMessages: verified.inboxMessages };
  }

  /** Resume on boot for an already-connected account. */
  async resume(): Promise<boolean> {
    const r = await this.d.db.query<{ external_account: string }>(
      `SELECT external_account FROM account_connection WHERE owner_id = $1 AND connector_id = $2 AND environment = $3 AND connected AND revoked_at IS NULL LIMIT 1`,
      [this.d.ownerId, CONNECTOR, this.d.environment],
    );
    const address = r.rows[0]?.external_account;
    if (!address) return false;
    await this.start(address);
    return true;
  }

  async disconnect(actor: string, reason = 'disconnected by Bruno'): Promise<void> {
    await this.worker?.stop();
    this.worker = undefined;
    if (this.address) {
      await this.d.vault.revoke(this.accountId(this.address));
      await this.d.db.query('UPDATE account_connection SET connected = false, revoked_at = now(), last_error = $2 WHERE id = $1', [this.accountId(this.address), reason]);
      this.d.audit.record(actor, 'connector.disconnected', this.accountId(this.address), { reason });
    }
    this.d.capabilities.markDisconnected(CONNECTOR, reason);
  }

  async syncNow(): Promise<number> {
    if (!this.worker) throw new JenniferError('gmail.not_connected', 'Gmail is not connected');
    return this.worker.syncOnce();
  }

  /** Import the last `days` of inbox history for context (missions, chat). Duplicates are ignored. */
  async importHistory(days: number, actor: string): Promise<{ imported: number }> {
    if (!this.address) throw new JenniferError('gmail.not_connected', 'Gmail is not connected');
    const n = Math.min(Math.max(1, Math.floor(days)), 30);
    const mailbox = new ImapMailbox(this.d.imap ?? GMAIL_IMAP, await this.creds());
    const emails = await mailbox.history(n);
    const handoff = this.d.onHistory ?? this.d.onEmail;
    for (const e of emails) await handoff(toInbound(e, { accountId: this.accountId(this.address), connectorId: CONNECTOR, space: this.d.space ?? 'personal', clock: this.d.clock }));
    this.d.audit.record(actor, 'connector.history_imported', this.accountId(this.address), { days: n, messages: emails.length });
    return { imported: emails.length };
  }

  info() {
    return { connector: CONNECTOR, address: this.address, worker: this.status };
  }

  private async start(address: string): Promise<void> {
    await this.worker?.stop();
    this.address = address;
    const accountId = this.accountId(address);
    this.d.registerConnector(new GmailConnector({ id: CONNECTOR, imap: this.d.imap, smtp: this.d.smtp, creds: this.creds }));
    this.d.capabilities.markConnected(CONNECTOR, accountId, address);
    const mailbox = new ImapMailbox(this.d.imap ?? GMAIL_IMAP, await this.creds());
    this.worker = new MailboxWorker({
      mailbox,
      connectorId: CONNECTOR,
      accountId,
      space: this.d.space ?? 'personal',
      cursors: new PgCursorStore(this.d.db, this.d.ownerId),
      clock: this.d.clock,
      onEmail: this.d.onEmail,
      onSynced: () => {
        this.d.capabilities.recordSync(CONNECTOR);
        this.d.capabilities.markVerified(CONNECTOR, 'read', 'IMAP sync succeeded');
        void this.d.db.query('UPDATE account_connection SET last_sync_at = now() WHERE id = $1', [accountId]);
      },
      onStatus: (s) => {
        this.status = s;
        if (s.state === 'auth_failed') {
          this.d.capabilities.markDisconnected(CONNECTOR, s.detail);
          void this.d.db.query('UPDATE account_connection SET connected = false, last_error = $2 WHERE id = $1', [accountId, s.detail]);
          this.d.audit.record('system', 'connector.auth_failed', accountId, { detail: s.detail });
        }
      },
    });
    this.worker.start();
  }
}

export { GMAIL_IMAP, GMAIL_SMTP };
