import { type Channel, type Space, JenniferError } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';

export interface Attachment {
  id: string;
  ownerId: string;
  space: Space;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageRef: string;
  scanStatus: 'pending' | 'clean' | 'infected' | 'unscannable';
  sensitivity: 'normal' | 'sensitive' | 'restricted';
  /** Contacts this attachment may be shared with, when restricted by purpose. */
  shareableWithContactIds?: string[];
}

export interface Message {
  id: string;
  ownerId: string;
  accountId: string;
  conversationId: string;
  providerMessageId?: string;
  providerThreadId?: string;
  direction: 'inbound' | 'outbound';
  channel: Channel;
  status: 'received' | 'draft' | 'provider_accepted' | 'delivered' | 'failed';
  from: { displayName?: string; address: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  body: string;
  headers: Record<string, string>;
  attachmentIds: string[];
  language?: string;
  occurredAt: Date;
  /** Untrusted-content flags raised during ingestion (spec §17). */
  flags: string[];
}

export interface Conversation {
  id: string;
  ownerId: string;
  accountId: string;
  channel: Channel;
  space: Space;
  providerThreadId?: string;
  subject?: string;
  participantContactIds: string[];
  messageIds: string[];
  /** Monotonic revision: bumps on every new inbound message (context change). */
  revision: number;
}

export interface ConversationChange {
  conversation?: Conversation;
  message?: Message;
  attachment?: Attachment;
  purgedMessageIds?: string[];
}

export class ConversationStore {
  private conversations = new Map<string, Conversation>();
  private messages = new Map<string, Message>();
  private attachments = new Map<string, Attachment>();
  private listeners: Array<(e: ConversationChange) => void> = [];

  constructor(private clock: Clock) {}

  /** Durable sinks receive every change (conversation, message, attachment). */
  onChange(fn: (e: ConversationChange) => void): void {
    this.listeners.push(fn);
  }

  private emit(e: ConversationChange): void {
    for (const l of this.listeners) l(e);
  }

  /** Rehydrate after restart. */
  restore(data: { conversations: Conversation[]; messages: Message[]; attachments: Attachment[] }): void {
    for (const c of data.conversations) this.conversations.set(c.id, c);
    for (const m of data.messages) this.messages.set(m.id, m);
    for (const a of data.attachments) this.attachments.set(a.id, a);
  }

  /**
   * Retention (spec §17): remove message bodies older than `cutoff`, except in
   * conversations that still have work pending. Conversations stay as headers.
   */
  purgeMessagesBefore(cutoff: Date, keepConversationIds: Set<string>): string[] {
    const purged: string[] = [];
    for (const m of this.messages.values()) {
      if (m.occurredAt.getTime() >= cutoff.getTime() || keepConversationIds.has(m.conversationId)) continue;
      this.messages.delete(m.id);
      const c = this.conversations.get(m.conversationId);
      if (c) c.messageIds = c.messageIds.filter((id) => id !== m.id);
      purged.push(m.id);
    }
    if (purged.length) this.emit({ purgedMessageIds: purged });
    return purged;
  }

  findByThread(accountId: string, providerThreadId: string): Conversation | undefined {
    return [...this.conversations.values()].find((c) => c.accountId === accountId && c.providerThreadId === providerThreadId);
  }

  upsertConversation(input: Omit<Conversation, 'id' | 'messageIds' | 'revision'> & { id?: string }): Conversation {
    if (input.providerThreadId) {
      const existing = [...this.conversations.values()].find(
        (c) => c.accountId === input.accountId && c.providerThreadId === input.providerThreadId,
      );
      if (existing) return existing;
    }
    const c: Conversation = { ...input, id: input.id ?? newId('conv'), messageIds: [], revision: 0 };
    this.conversations.set(c.id, c);
    this.emit({ conversation: c });
    return c;
  }

  getConversation(id: string): Conversation {
    const c = this.conversations.get(id);
    if (!c) throw new JenniferError('conversation.not_found', `No conversation ${id}`);
    return c;
  }

  listConversations(ownerId: string): Conversation[] {
    return [...this.conversations.values()].filter((c) => c.ownerId === ownerId);
  }

  addMessage(input: Omit<Message, 'id'>): Message {
    const conv = this.getConversation(input.conversationId);
    if (input.providerMessageId) {
      const dup = [...this.messages.values()].find((m) => m.accountId === input.accountId && m.providerMessageId === input.providerMessageId);
      if (dup) return dup;
    }
    const m: Message = { ...input, id: newId('msg') };
    this.messages.set(m.id, m);
    conv.messageIds.push(m.id);
    if (m.direction === 'inbound') conv.revision++;
    this.emit({ message: m, conversation: conv });
    return m;
  }

  getMessage(id: string): Message {
    const m = this.messages.get(id);
    if (!m) throw new JenniferError('message.not_found', `No message ${id}`);
    return m;
  }

  messagesIn(conversationId: string): Message[] {
    return this.getConversation(conversationId).messageIds.map((id) => this.messages.get(id)!);
  }

  latestInbound(conversationId: string): Message | undefined {
    return this.messagesIn(conversationId).filter((m) => m.direction === 'inbound').at(-1);
  }

  searchMessages(ownerId: string, query: string, spaces: Space[]): Message[] {
    const q = query.toLowerCase();
    return [...this.messages.values()].filter((m) => {
      if (m.ownerId !== ownerId) return false;
      const conv = this.conversations.get(m.conversationId)!;
      if (!spaces.includes(conv.space)) return false;
      return (m.subject ?? '').toLowerCase().includes(q) || m.body.toLowerCase().includes(q);
    });
  }

  addAttachment(input: Omit<Attachment, 'id'>): Attachment {
    const a: Attachment = { ...input, id: newId('att') };
    this.attachments.set(a.id, a);
    this.emit({ attachment: a });
    return a;
  }

  getAttachment(id: string): Attachment {
    const a = this.attachments.get(id);
    if (!a) throw new JenniferError('attachment.not_found', `No attachment ${id}`);
    return a;
  }
}

/**
 * Exclude bounces, mailing lists and out-of-office messages from
 * conversational reply loops (spec §6).
 */
export function classifyAutomatedEmail(headers: Record<string, string>, from: string, subject = ''): string | undefined {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
  const f = from.toLowerCase();
  if (/^(mailer-daemon|postmaster)@/.test(f) || (h['content-type'] ?? '').includes('multipart/report')) return 'bounce';
  if (h['list-id'] || h['list-unsubscribe'] || ['bulk', 'list', 'junk'].includes(h['precedence'] ?? '')) return 'mailing_list';
  if ((h['auto-submitted'] && h['auto-submitted'] !== 'no') || h['x-autoreply'] || h['x-autorespond']) return 'auto_reply';
  if (/^(automatic reply|auto(?:matic)?[- ]?reply|out of (?:the )?office|risposta automatica|resposta automática|respuesta automática)/i.test(subject))
    return 'auto_reply';
  if (/^(no-?reply|do-?not-?reply)@/.test(f)) return 'no_reply_sender';
  return undefined;
}
