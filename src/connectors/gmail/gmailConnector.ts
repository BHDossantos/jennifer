import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { MessagingConnector, OutboundMessage, SendResult } from '../connector.js';
import { GMAIL_IMAP, GMAIL_SMTP, ImapMailbox, type MailCredentials, type MailServer } from './imap.js';

/** Deterministic Message-ID per action: retries reuse it, reconciliation searches for it. */
export function messageIdFor(idempotencyKey: string): string {
  return `${idempotencyKey}@jennifer.mail`;
}

export interface GmailConnectorOptions {
  id?: string;
  imap?: MailServer;
  smtp?: MailServer;
  creds: () => Promise<MailCredentials>; // fetched from the vault per use; never cached in logs
  loadAttachment?: (storageRef: string) => Promise<Buffer>;
  /** Gmail can take a moment to file a sent message; below this age a miss is "pending", not "absent". */
  reconcileGraceMs?: number;
}

/**
 * Gmail send path: SMTP submission with an app password. Gmail files the
 * message in Sent Mail, where reconciliation finds it by Message-ID.
 */
export class GmailConnector implements MessagingConnector {
  readonly id: string;
  readonly reconcileGraceMs: number;

  constructor(private o: GmailConnectorOptions) {
    this.id = o.id ?? 'gmail';
    this.reconcileGraceMs = o.reconcileGraceMs ?? 120_000;
  }

  private async mailbox(): Promise<ImapMailbox> {
    return new ImapMailbox(this.o.imap ?? GMAIL_IMAP, await this.o.creds());
  }

  private async mailOptions(msg: OutboundMessage) {
    const creds = await this.o.creds();
    const attachments = [];
    for (const a of msg.attachments) {
      if (!this.o.loadAttachment) throw new Error('attachment storage is not configured');
      attachments.push({ filename: a.filename, content: await this.o.loadAttachment(a.storageRef) });
    }
    return {
      creds,
      mail: {
        from: creds.address,
        to: msg.to,
        cc: msg.cc,
        bcc: msg.bcc,
        subject: msg.subject ?? '',
        text: msg.body,
        messageId: `<${messageIdFor(msg.idempotencyKey)}>`,
        inReplyTo: msg.replyHeaders?.inReplyTo ? `<${msg.replyHeaders.inReplyTo}>` : undefined,
        references: msg.replyHeaders?.references.map((r) => `<${r}>`),
        headers: { 'X-Jennifer-Action': msg.idempotencyKey },
        attachments,
      },
    };
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    let prepared;
    try {
      prepared = await this.mailOptions(msg);
    } catch (e) {
      return { kind: 'rejected', error: (e as Error).message, retryable: false };
    }
    const smtp = this.o.smtp ?? GMAIL_SMTP;
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: prepared.creds.address, pass: prepared.creds.password },
      tls: smtp.allowSelfSigned ? { rejectUnauthorized: false } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    try {
      const info = await transport.sendMail(prepared.mail);
      return { kind: 'accepted', providerMessageId: `mid:${messageIdFor(msg.idempotencyKey)}`, deliveryStatus: info.accepted?.length ? 'accepted' : 'accepted' };
    } catch (e) {
      return classifySmtpError(e as SmtpError);
    } finally {
      transport.close();
    }
  }

  async findByIdempotencyKey(_accountId: string, key: string): Promise<{ providerMessageId: string } | undefined> {
    const found = await (await this.mailbox()).findSent(messageIdFor(key));
    return found ? { providerMessageId: `mid:${messageIdFor(key)}` } : undefined;
  }

  /** Draft mode: put the exact reviewed message in Gmail Drafts. */
  async createDraft(msg: OutboundMessage): Promise<{ draftMessageId: string }> {
    const { mail } = await this.mailOptions(msg);
    const raw = await new MailComposer(mail).compile().build();
    await (await this.mailbox()).appendDraft(raw);
    return { draftMessageId: messageIdFor(msg.idempotencyKey) };
  }
}

interface SmtpError {
  code?: string;
  command?: string;
  responseCode?: number;
  message: string;
}

/**
 * Nothing was accepted if SMTP failed before DATA completed; a failure
 * during or after DATA is ambiguous and must be reconciled, never resent.
 */
export function classifySmtpError(e: SmtpError): SendResult {
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534)
    return { kind: 'rejected', error: `unauthorized: Gmail rejected the app password (${e.responseCode ?? e.code})`, retryable: false };
  if (e.command === 'DATA' || (e.code && ['ETIMEDOUT', 'ECONNRESET', 'ESOCKET'].includes(e.code) && (!e.command || e.command === 'DATA')))
    return { kind: 'timeout' };
  if (e.responseCode && e.responseCode >= 500) return { kind: 'rejected', error: `SMTP ${e.responseCode}: ${e.message}`, retryable: false };
  return { kind: 'rejected', error: `SMTP ${e.responseCode ?? e.code ?? ''}: ${e.message}`, retryable: true };
}
