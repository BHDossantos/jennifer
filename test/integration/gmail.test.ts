import { afterEach, describe, expect, it } from 'vitest';
import hoodiecrow from 'hoodiecrow-imap';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { createJennifer } from '../../src/app.js';
import { FakeClock } from '../../src/core/util.js';
import { ScriptedModel } from '../../src/core/model.js';
import { GmailConnector, messageIdFor } from '../../src/connectors/gmail/gmailConnector.js';
import { ImapMailbox, MailAuthError, type MailServer } from '../../src/connectors/gmail/imap.js';
import { MailboxWorker, MemoryCursorStore, type WorkerStatus } from '../../src/connectors/gmail/worker.js';

const ADDRESS = 'bruno@gmail.test';
const PASSWORD = 'abcdefghijklmnop';
let port = 21430;

interface Fake {
  imap: MailServer;
  smtp: MailServer;
  imapServer: any;
  smtpServer: SMTPServer;
  received: Array<{ raw: string; parsed: Awaited<ReturnType<typeof simpleParser>> }>;
  failDataOnce: boolean;
  deliver: (raw: string) => void;
  close: () => Promise<void>;
}

/** Local IMAP (Gmail extensions) + SMTP that files submissions into Sent Mail like Gmail. */
async function fakeGmail(): Promise<Fake> {
  const imapPort = port++;
  const smtpPort = port++;
  const imapServer = hoodiecrow({
    plugins: ['ID', 'IDLE', 'UNSELECT', 'ENABLE', 'CONDSTORE', 'SPECIAL-USE', 'X-GM-EXT-1', 'UIDPLUS', 'LITERALPLUS', 'SASL-IR', 'AUTH-PLAIN'],
    users: { [ADDRESS]: { password: PASSWORD } },
    storage: {
      INBOX: { messages: [{ raw: 'From: old@x.test\r\nSubject: Old mail\r\nMessage-ID: <old1@x.test>\r\n\r\nalready there' }] },
      '': { separator: '/', folders: { '[Gmail]': { flags: ['\\Noselect'], folders: { 'Sent Mail': { 'special-use': '\\Sent' }, Drafts: { 'special-use': '\\Drafts' } } } } },
    },
  });
  await new Promise<void>((r) => imapServer.listen(imapPort, r));
  const fake = { received: [], failDataOnce: false } as unknown as Fake;
  const smtpServer = new SMTPServer({
    secure: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, _s, cb) {
      if (auth.username === ADDRESS && auth.password === PASSWORD) cb(null, { user: ADDRESS });
      else cb(Object.assign(new Error('Username and Password not accepted'), { responseCode: 535 }));
    },
    onData(stream, _s, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', async () => {
        const raw = Buffer.concat(chunks).toString();
        imapServer.appendMessage('[Gmail]/Sent Mail', ['\\Seen'], false, raw);
        fake.received.push({ raw, parsed: await simpleParser(raw) });
        if (fake.failDataOnce) {
          fake.failDataOnce = false;
          cb(Object.assign(new Error('connection lost after DATA'), { responseCode: 451 }));
        } else cb();
      });
    },
  });
  await new Promise<void>((r) => smtpServer.listen(smtpPort, '127.0.0.1', r));
  Object.assign(fake, {
    imap: { host: '127.0.0.1', port: imapPort, secure: false },
    smtp: { host: '127.0.0.1', port: smtpPort, secure: false },
    imapServer,
    smtpServer,
    deliver: (raw: string) => imapServer.appendMessage('INBOX', [], false, raw),
    close: async () => {
      await new Promise<void>((r) => smtpServer.close(() => r()));
      imapServer.close();
    },
  });
  return fake;
}

const fakes: Fake[] = [];
afterEach(async () => {
  while (fakes.length) await fakes.pop()!.close();
});

async function setup(opts: { sandbox?: string[] } = {}) {
  const f = await fakeGmail();
  fakes.push(f);
  const clock = new FakeClock('2026-10-03T08:00:00Z');
  const creds = async () => ({ address: ADDRESS, password: PASSWORD });
  const gmail = new GmailConnector({ imap: f.imap, smtp: f.smtp, creds, reconcileGraceMs: 0 });
  const model = new ScriptedModel(() => JSON.stringify({ reply: 'Thursday at 16:00 works for me.', cited_memory_ids: [], escalate: false, escalation_reason: '' }));
  const j = createJennifer({ clock, model, emailConnectors: [gmail], random: () => 0.5, config: { ownerId: 'bruno' }, sandboxRecipients: opts.sandbox });
  j.capabilities.markConnected('gmail', ADDRESS);
  const marco = j.contacts.add({ ownerId: 'bruno', displayName: 'Marco Bianchi', spaces: ['personal'], identities: [{ kind: 'email', value: 'marco@bianchi.test', verified: true, source: 'test' }] });
  const mailbox = new ImapMailbox(f.imap, await creds());
  const cursors = new MemoryCursorStore();
  const worker = new MailboxWorker({
    mailbox,
    connectorId: 'gmail',
    accountId: ADDRESS,
    space: 'personal',
    cursors,
    clock,
    onEmail: async (e) => void (await j.inbound.handle(e, { autoDraft: true })),
    onSent: async (e) => void j.inbound.handleSent(e),
    onSynced: () => j.capabilities.recordSync('gmail'),
  });
  return { f, j, gmail, mailbox, worker, cursors, marco };
}

const marcoMail = (id: string, extra = '') =>
  `From: Marco Bianchi <marco@bianchi.test>\r\nTo: ${ADDRESS}\r\nSubject: Thursday?\r\nMessage-ID: <${id}@bianchi.test>\r\n${extra}Content-Type: text/plain\r\n\r\nCan we meet Thursday afternoon?`;

describe('Gmail connector (IMAP + SMTP, app password)', () => {
  it('rejects a bad app password as an auth failure', async () => {
    const { f } = await setup();
    await expect(new ImapMailbox(f.imap, { address: ADDRESS, password: 'wrong' }).verify()).rejects.toBeInstanceOf(MailAuthError);
  });

  it('first sync starts from now; later syncs ingest new mail exactly once', async () => {
    const { f, j, worker } = await setup();
    expect(await worker.syncOnce()).toBe(0); // no backfill of old mail without an explicit import
    f.deliver(marcoMail('m1'));
    expect(await worker.syncOnce()).toBe(1);
    expect(await worker.syncOnce()).toBe(0);
    const convs = j.conversations.listConversations('bruno');
    expect(convs).toHaveLength(1);
    expect(convs[0]!.providerThreadId).toBe('mid:m1@bianchi.test');
  });

  it('threads replies by References and sends an approved reply with correct headers', async () => {
    const { f, j, worker } = await setup();
    await worker.syncOnce();
    f.deliver(marcoMail('m1'));
    await worker.syncOnce();
    f.deliver(marcoMail('m2', 'In-Reply-To: <m1@bianchi.test>\r\nReferences: <m1@bianchi.test>\r\n'));
    await worker.syncOnce();
    const [conv] = j.conversations.listConversations('bruno');
    expect(j.conversations.messagesIn(conv!.id)).toHaveLength(2); // same thread

    const pending = j.actions.list({ state: 'awaiting_decision' });
    expect(pending).toHaveLength(1); // first draft was invalidated by the second message
    const a = pending[0]!;
    j.actions.approve(a.id, 'bruno', { revision: a.revision, payloadHash: a.payloadHash });
    await j.actions.execute(a.id);
    expect(j.actions.get(a.id).state).toBe('provider_accepted');
    expect(f.received).toHaveLength(1);
    const sent = f.received[0]!.parsed;
    expect(sent.messageId).toBe(`<${messageIdFor(a.idempotencyKey)}>`);
    expect(sent.inReplyTo).toBe('<m2@bianchi.test>');
    expect(sent.references).toEqual(['<m1@bianchi.test>', '<m2@bianchi.test>']);
    expect(sent.subject).toBe('Re: Thursday?');
    expect(sent.text?.trim()).toBe('Thursday at 16:00 works for me.');
  });

  it('Bruno replying himself from Gmail cancels Jennifer\'s pending reply (Sent folder sync)', async () => {
    const { f, j, worker } = await setup();
    await worker.syncOnce();
    await worker.syncSent(true); // first look at Sent starts from "now"
    f.deliver(marcoMail('m1'));
    await worker.syncOnce();
    const [pending] = j.actions.list({ state: 'awaiting_decision' });
    expect(pending).toBeDefined();
    f.imapServer.appendMessage('[Gmail]/Sent Mail', ['\\Seen'], false, `From: Bruno <${ADDRESS}>\r\nTo: marco@bianchi.test\r\nSubject: Re: Thursday?\r\nMessage-ID: <manual1@mail.gmail.com>\r\nIn-Reply-To: <m1@bianchi.test>\r\nReferences: <m1@bianchi.test>\r\n\r\nSure, 4pm!`);
    expect(await worker.syncSent(true)).toBe(1);
    expect(j.actions.get(pending!.id)).toMatchObject({ state: 'canceled', stateReason: 'Bruno replied manually' });
    const [conv] = j.conversations.listConversations('bruno');
    expect(j.conversations.messagesIn(conv!.id).map((m) => m.direction)).toEqual(['inbound', 'outbound']);
  });

  it('a failure after DATA is reconciled through Sent Mail, never resent', async () => {
    const { f, j } = await setup();
    j.authority.grant({ principal: 'bruno', action: 'send_message', mode: 'execute', scope: { accountIds: [ADDRESS] } });
    f.failDataOnce = true;
    const a = j.actions.propose({ ownerId: 'bruno', type: 'send_message', space: 'personal', channel: 'email', connectorId: 'gmail', accountId: ADDRESS, payload: { to: ['marco@bianchi.test'], cc: [], bcc: [], subject: 'Hi', body: 'Hello', attachmentIds: [], evidence: [] }, proposedBy: 'test' });
    await j.actions.execute(a.id);
    expect(j.actions.get(a.id).state).toBe('unknown');
    await j.actions.recoverUnknown();
    expect(j.actions.get(a.id).state).toBe('provider_accepted');
    await j.actions.runDue();
    expect(f.received).toHaveLength(1);
  });

  it('a revoked app password disconnects the connector and blocks further sends', async () => {
    const { f, j } = await setup();
    const bad = new GmailConnector({ imap: f.imap, smtp: f.smtp, creds: async () => ({ address: ADDRESS, password: 'revoked' }) });
    j.emailConnectors.set('gmail', bad);
    const a = j.actions.propose({ ownerId: 'bruno', type: 'send_message', space: 'personal', channel: 'email', connectorId: 'gmail', accountId: ADDRESS, payload: { to: ['marco@bianchi.test'], cc: [], bcc: [], body: 'x', attachmentIds: [], evidence: [] }, proposedBy: 'test' });
    j.actions.approve(a.id, 'bruno', { revision: a.revision, payloadHash: a.payloadHash });
    await j.actions.execute(a.id);
    expect(j.actions.get(a.id).state).toBe('failed');
    expect(j.capabilities.get('gmail')!.connected).toBe(false);
    expect(j.dailyBrief().connectorHealth.find((c) => c.connector === 'gmail')!.state).toBe('disconnected');
  });

  it('sandbox mode hard-blocks recipients outside the test list', async () => {
    const { j } = await setup({ sandbox: [ADDRESS] });
    const a = j.actions.propose({ ownerId: 'bruno', type: 'send_message', space: 'personal', channel: 'email', connectorId: 'gmail', accountId: ADDRESS, payload: { to: ['marco@bianchi.test'], cc: [], bcc: [], body: 'x', attachmentIds: [], evidence: [] }, proposedBy: 'test' });
    expect(a.state).toBe('failed');
    expect(a.stateReason).toMatch(/sandbox mode/);
  });

  it('draft mode places the exact message in Gmail Drafts', async () => {
    const { f, gmail } = await setup();
    await gmail.createDraft({ accountId: ADDRESS, conversationId: 'c', to: ['marco@bianchi.test'], cc: [], bcc: [], subject: 'Draft', body: 'For you to send', attachments: [], idempotencyKey: 'idem_draft1' });
    const drafts = f.imapServer.getMailbox('[Gmail]/Drafts');
    expect(drafts.messages).toHaveLength(1);
    expect(drafts.messages[0].flags).toContain('\\Draft');
  });

  it('IDLE delivers new mail without polling', async () => {
    const { f, j, worker } = await setup();
    const statuses: WorkerStatus['state'][] = [];
    (worker as any).o.onStatus = (s: WorkerStatus) => statuses.push(s.state);
    worker.start();
    await waitFor(() => statuses.includes('idle'));
    f.deliver(marcoMail('live1'));
    await waitFor(() => j.conversations.listConversations('bruno').length === 1);
    await worker.stop();
    expect(statuses).toContain('stopped');
  });

  it('worker stops with auth_failed when the app password is revoked', async () => {
    const { f, j } = await setup();
    const statuses: WorkerStatus[] = [];
    const w = new MailboxWorker({ mailbox: new ImapMailbox(f.imap, { address: ADDRESS, password: 'revoked' }), connectorId: 'gmail', accountId: ADDRESS, space: 'personal', cursors: new MemoryCursorStore(), clock: j.clock, onEmail: async () => {}, onStatus: (s) => statuses.push(s) });
    w.start();
    await waitFor(() => statuses.some((s) => s.state === 'auth_failed'));
  });
});

async function waitFor(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('GmailService (connect, resume, disconnect)', () => {
  it('verifies the app password, stores it only in the vault, resumes after restart', async () => {
    const { pgliteDb } = await import('../../src/db/db.js');
    const { createDurableJennifer } = await import('../../src/app.js');
    const { Vault, LocalKeyWrapper } = await import('../../src/identity/vault.js');
    const { GmailService } = await import('../../src/connectors/gmail/service.js');
    const { randomBytes } = await import('node:crypto');
    const f = await fakeGmail();
    fakes.push(f);
    const db = await pgliteDb();
    const key = new Map([[1, randomBytes(32)]]);
    const boot = async () => {
      const j = await createDurableJennifer({ db, clock: new FakeClock('2026-10-03T08:00:00Z'), config: { ownerId: 'bruno' }, emailConnectors: [] });
      const svc = new GmailService({
        db, vault: new Vault(db, new LocalKeyWrapper(key)), clock: j.clock, audit: j.audit, capabilities: j.capabilities, ownerId: 'bruno', environment: 'test',
        imap: f.imap, smtp: f.smtp,
        onEmail: async (e) => void (await j.inbound.handle(e)),
        registerConnector: (c) => j.emailConnectors.set(c.id, c),
      });
      return { j, svc };
    };

    const a = await boot();
    await expect(a.svc.connect(ADDRESS, 'wrong-password-123', 'bruno')).rejects.toThrow(/rejected the app password/);
    const r = await a.svc.connect(ADDRESS, 'abcd efgh ijkl mnop', 'bruno'); // pasted as Google shows it
    expect(r.inboxMessages).toBe(1);
    const stored = await db.query('SELECT * FROM vault_secret');
    expect(JSON.stringify(stored.rows)).not.toContain(PASSWORD);
    await waitFor(() => a.svc.info().worker.state === 'idle');
    expect(a.j.capabilities.get('gmail')!.capabilities.read.status).toBe('verified');
    f.deliver(marcoMail('svc1'));
    await waitFor(() => a.j.conversations.listConversations('bruno').length === 1);
    await a.svc.disconnect('bruno', 'test restart'); // simulate shutdown below by resuming a new instance

    // Re-connect, then "restart" with a fresh process: resume picks up from the stored cursor.
    await a.svc.connect(ADDRESS, PASSWORD, 'bruno');
    await waitFor(() => a.svc.info().worker.state === 'idle');
    await (a.svc as any).worker.stop();
    f.deliver(marcoMail('svc2'));
    const b = await boot();
    expect(await b.svc.resume()).toBe(true);
    await waitFor(() => b.j.conversations.listConversations('bruno').some((c) => c.providerThreadId === 'mid:svc2@bianchi.test'));
    // svc1 survived the restart (persisted) but was not ingested a second time.
    const svc1 = b.j.conversations.listConversations('bruno').find((c) => c.providerThreadId === 'mid:svc1@bianchi.test')!;
    expect(b.j.conversations.messagesIn(svc1.id)).toHaveLength(1);

    await b.svc.disconnect('bruno');
    expect(b.j.capabilities.get('gmail')!.connected).toBe(false);
    expect(await boot().then((c) => c.svc.resume())).toBe(false);
    await b.j.store.flush();
  });
});

describe('Gmail history import', () => {
  it('imports recent inbox mail for context without drafting replies, and is idempotent', async () => {
    const { f, j, mailbox } = await setup();
    f.deliver(marcoMail('h1'));
    f.deliver(marcoMail('h2', 'In-Reply-To: <h1@bianchi.test>\r\nReferences: <h1@bianchi.test>\r\n'));
    const emails = await mailbox.history(7);
    expect(emails.map((e) => e.parsed.messageId)).toEqual(expect.arrayContaining(['old1@x.test', 'h1@bianchi.test', 'h2@bianchi.test']));
    for (const e of emails) await j.inbound.handle((await import('../../src/connectors/gmail/worker.js')).toInbound(e, { accountId: ADDRESS, connectorId: 'gmail', space: 'personal', clock: j.clock }), { autoDraft: false });
    expect(j.actions.list()).toHaveLength(0); // no replies drafted for history
    const before = j.conversations.listConversations('bruno').length;
    for (const e of await mailbox.history(7)) await j.inbound.handle((await import('../../src/connectors/gmail/worker.js')).toInbound(e, { accountId: ADDRESS, connectorId: 'gmail', space: 'personal', clock: j.clock }));
    expect(j.conversations.listConversations('bruno').length).toBe(before);
  });
});

describe('SMTP error classification (no duplicate sends)', () => {
  it('only pre-DATA failures are retried; connection drops after sending are reconciled', async () => {
    const { classifySmtpError } = await import('../../src/connectors/gmail/gmailConnector.js');
    expect(classifySmtpError({ code: 'ETIMEDOUT', command: 'CONN', message: 'Timeout' })).toEqual({ kind: 'timeout' });
    expect(classifySmtpError({ code: 'ECONNECTION', command: 'CONN', message: 'Connection closed' })).toEqual({ kind: 'timeout' });
    expect(classifySmtpError({ code: 'ESOCKET', message: 'socket hang up' })).toEqual({ kind: 'timeout' });
    expect(classifySmtpError({ code: 'EMESSAGE', command: 'DATA', responseCode: 451, message: 'try later' })).toEqual({ kind: 'timeout' });
    expect(classifySmtpError({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 450, message: 'busy' })).toMatchObject({ kind: 'rejected', retryable: true });
    expect(classifySmtpError({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, message: 'no such user' })).toMatchObject({ kind: 'rejected', retryable: false });
    expect(classifySmtpError({ code: 'EMESSAGE', command: 'DATA', responseCode: 552, message: 'too big' })).toMatchObject({ kind: 'rejected', retryable: false });
    expect(classifySmtpError({ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535, message: 'bad' })).toMatchObject({ kind: 'rejected', retryable: false });
  });
});
