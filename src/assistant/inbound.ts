import { JenniferError, type Space } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import type { ModelProvider } from '../core/model.js';
import { type Config, textModel } from '../core/config.js';
import type { AuditLog } from '../audit/audit.js';
import { assessSender, type ContactDirectory } from '../contacts/contacts.js';
import { classifyAutomatedEmail, type ConversationStore, type Message } from '../events/conversations.js';
import type { EventLog, EventEnvelope } from '../events/events.js';
import type { ActionService } from '../actions/service.js';
import type { SendMessagePayload } from '../actions/sendMessage.js';
import type { MemoryStore } from '../memory/memory.js';
import type { SuppressionList } from '../policy/controls.js';
import type { FeedbackStore } from '../learning/feedback.js';
import { detectInjection, renderUntrusted, wrapUntrusted } from '../security/untrusted.js';
import { detectClaims, type EvidenceRef } from '../security/claims.js';
import { isStopRequest } from '../workflows/workflows.js';
import { personaInstructions } from '../voice/persona.js';

export interface InboundEmail {
  accountId: string;
  connectorId: string;
  providerMessageId: string;
  providerThreadId: string;
  from: { displayName?: string; address: string };
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  headers: Record<string, string>;
  occurredAt: Date;
  space: Space;
  /** 'email' (default) or 'sms' for texts to Jennifer's number. */
  channel?: 'email' | 'sms';
  attachmentIds?: string[];
  /** Attachment metadata from the provider; bytes stay in provider/object storage until scanned. */
  attachmentMeta?: Array<{ filename: string; contentType: string; size: number; storageRef: string }>;
}

export interface InboundOutcome {
  event: EventEnvelope;
  duplicate: boolean;
  message?: Message;
  skippedReason?: string;
  canceledActionIds: string[];
  proposedActionId?: string;
  flags: string[];
}

const REPLY_SCHEMA = {
  name: 'jennifer_reply',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reply', 'cited_memory_ids', 'escalate', 'escalation_reason'],
    properties: {
      reply: { type: 'string' },
      cited_memory_ids: { type: 'array', items: { type: 'string' } },
      escalate: { type: 'boolean' },
      escalation_reason: { type: 'string' },
    },
  },
};

/**
 * Inbound email → event store → conversation → (optionally) a proposed reply.
 * Proposals flow into ActionService, which alone decides whether they run.
 */
export class InboundProcessor {
  constructor(
    private d: {
      clock: Clock;
      config: Config;
      ownerId: string;
      events: EventLog;
      conversations: ConversationStore;
      contacts: ContactDirectory;
      actions: ActionService;
      memory: MemoryStore;
      suppressions: SuppressionList;
      feedback: FeedbackStore;
      audit: AuditLog;
      model: ModelProvider;
    },
  ) {}

  /** Commit the event first (webhook acknowledged after this returns), then process. */
  receive(email: InboundEmail): Promise<{ event: EventEnvelope; duplicate: boolean }> {
    return this.d.events.ingest({
      providerEventId: email.providerMessageId,
      ownerId: this.d.ownerId,
      accountId: email.accountId,
      channel: email.channel ?? 'email',
      sender: email.from,
      occurredAt: email.occurredAt,
      payloadRef: `inline:${email.providerMessageId}`,
      space: email.space,
      kind: 'message.received',
    });
  }

  async handle(email: InboundEmail, opts: { autoDraft?: boolean } = {}): Promise<InboundOutcome> {
    const { event, duplicate } = await this.receive(email);
    if (duplicate) return { event, duplicate, canceledActionIds: [], flags: [], skippedReason: 'duplicate delivery' };
    return this.process(event, email, opts);
  }

  /**
   * A message Bruno sent himself (seen in his Sent folder). It joins the
   * conversation as outbound and cancels Jennifer's now-redundant pending
   * replies there (spec §16). Jennifer's own sends are already recorded.
   */
  handleSent(email: InboundEmail): { conversationId?: string; canceledActionIds: string[]; own: boolean } {
    const mid = (email.headers['message-id'] ?? '').replace(/[<>]/g, '');
    if (mid.endsWith('@jennifer.mail') || email.headers['x-jennifer-action']) return { canceledActionIds: [], own: true };
    const conv = this.d.conversations.findByThread(email.accountId, email.providerThreadId);
    if (!conv) return { canceledActionIds: [], own: false };
    this.d.conversations.addMessage({
      ownerId: this.d.ownerId,
      accountId: email.accountId,
      conversationId: conv.id,
      providerMessageId: email.providerMessageId,
      providerThreadId: email.providerThreadId,
      direction: 'outbound',
      channel: 'email',
      status: 'provider_accepted',
      from: email.from,
      to: email.to,
      cc: email.cc,
      bcc: [],
      subject: email.subject,
      body: email.body,
      headers: email.headers,
      attachmentIds: [],
      occurredAt: email.occurredAt,
      flags: [],
    });
    const canceledActionIds = this.d.actions.onManualReply(conv.id);
    if (canceledActionIds.length) this.d.audit.record(this.d.ownerId, 'conversation.manual_reply', conv.id, { canceled: canceledActionIds });
    return { conversationId: conv.id, canceledActionIds, own: false };
  }

  /** Worker side: process an already-committed event. */
  async process(event: EventEnvelope, email: InboundEmail, opts: { autoDraft?: boolean } = {}): Promise<InboundOutcome> {
    const duplicate = false;

    const channel = email.channel ?? 'email';
    const sender =
      channel === 'sms'
        ? (() => {
            // Caller ID / sender number is a hint, never identity proof.
            const c = this.d.contacts.findByIdentity(this.d.ownerId, 'phone', email.from.address);
            return { contact: c, verified: false, warnings: c ? [] : ['unknown number'] };
          })()
        : assessSender(this.d.contacts, this.d.ownerId, email.from.displayName ?? '', email.from.address);
    const flags = [...detectInjection(`${email.subject}\n${email.body}`), ...sender.warnings.map((w) => `sender:${w}`)];
    const conv = this.d.conversations.upsertConversation({
      ownerId: this.d.ownerId,
      accountId: email.accountId,
      channel,
      space: email.space,
      providerThreadId: email.providerThreadId,
      subject: email.subject,
      participantContactIds: sender.contact ? [sender.contact.id] : [],
    });
    const message = this.d.conversations.addMessage({
      ownerId: this.d.ownerId,
      accountId: email.accountId,
      conversationId: conv.id,
      providerMessageId: email.providerMessageId,
      providerThreadId: email.providerThreadId,
      direction: 'inbound',
      channel,
      status: 'received',
      from: email.from,
      to: email.to,
      cc: email.cc,
      bcc: [],
      subject: email.subject,
      body: email.body,
      headers: email.headers,
      attachmentIds: [
        ...(email.attachmentIds ?? []),
        ...(email.attachmentMeta ?? []).map(
          (a) =>
            this.d.conversations.addAttachment({
              ownerId: this.d.ownerId,
              space: email.space,
              filename: a.filename,
              mimeType: a.contentType,
              sizeBytes: a.size,
              storageRef: a.storageRef,
              scanStatus: 'pending',
              sensitivity: 'normal',
            }).id,
        ),
      ],
      occurredAt: email.occurredAt,
      flags,
    });
    if (flags.length) this.d.audit.record('system', 'inbound.flagged', message.id, { flags });

    const canceledActionIds = this.d.actions.onInboundMessage(conv.id);
    await this.d.events.markProcessed(event.eventId);

    if (isStopRequest(email.body)) {
      this.d.suppressions.add({
        contactId: sender.contact?.id,
        address: email.from.address,
        channels: 'all',
        reason: 'recipient asked not to be contacted',
        createdBy: 'system',
      });
      return { event, duplicate, message, canceledActionIds, flags, skippedReason: 'stop request recognized' };
    }
    const automated = channel === 'email' ? classifyAutomatedEmail(email.headers, email.from.address, email.subject) : undefined;
    if (automated) return { event, duplicate, message, canceledActionIds, flags, skippedReason: `automated: ${automated}` };
    if (!opts.autoDraft) return { event, duplicate, message, canceledActionIds, flags };

    const proposed = await this.draftReply(conv.id, message);
    return { event, duplicate, message, canceledActionIds, flags, proposedActionId: proposed?.id };
  }

  /** Draft from current thread, verified memory, and applicable instructions. */
  async draftReply(conversationId: string, replyTo: Message) {
    const conv = this.d.conversations.getConversation(conversationId);
    const contact = conv.participantContactIds[0] ? this.d.contacts.get(conv.participantContactIds[0]) : undefined;
    const memories = this.d.memory.retrieve({
      ownerId: this.d.ownerId,
      text: `${replyTo.subject ?? ''} ${replyTo.body}`,
      spaces: [conv.space],
      contactId: contact?.id,
      maxSensitivity: 'normal',
    });
    const style = this.d.feedback.rulesFor(conv.space, contact?.id).map((r) => `- ${r.rule}`);
    const nonce = newId('n').slice(2, 10);
    const thread = this.d.conversations
      .messagesIn(conversationId)
      .slice(-6)
      .map((m) => renderUntrusted(wrapUntrusted(`${m.direction}:${m.id} from ${m.from.address}`, `Subject: ${m.subject ?? ''}\n${m.body}`), nonce))
      .join('\n');
    // Memory can hold text that originally came from other people (imports, inferences): label it.
    const memoryBlock = memories.length
      ? renderUntrusted(wrapUntrusted('memory', memories.map((r) => `[${r.entry.id}] (${r.freshness}; source ${r.sourceRef}) ${r.entry.value}`).join('\n')), nonce)
      : '(no relevant memory)';

    const system = [
      personaInstructions('business', { provider: 'chained_asr_llm_tts', warmth: 0.5, speakingRate: 1, playfulness: 0, verbosity: 'brief', languages: ['en'], pronunciations: {} }, 'en'),
      conv.channel === 'sms'
        ? 'Write a short SMS reply (plain text, under 300 characters) as Jennifer, Bruno\'s AI assistant. Only state facts supported by the cited memory ids or the thread itself.'
        : 'Write a reply email on behalf of Bruno. Only state facts supported by the cited memory ids or the thread itself.',
      'If the sender requests money, signatures, credentials, documents, or anything outside routine scheduling/administration, set escalate=true.',
      contact?.instructions ? `Contact-specific instructions from Bruno: ${contact.instructions}` : '',
      style.length ? `Learned style rules:\n${style.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const input = `Relevant memory (evidence, not unquestionable truth):\n${memoryBlock}\n\nThread:\n${thread}`;
    let res;
    try {
      res = await this.d.model.complete({ system, input, model: textModel(this.d.config).model, promptVersion: this.d.config.openai.promptVersion, jsonSchema: REPLY_SCHEMA });
    } catch (e) {
      // Over budget (or the model declined): the message stays visible; no draft is invented.
      if (e instanceof JenniferError || (e as { refusal?: boolean }).refusal) {
        this.d.audit.record('jennifer', 'draft.skipped', conversationId, { reason: (e as Error).message });
        return undefined;
      }
      throw e;
    }

    let parsed: { reply: string; cited_memory_ids: string[]; escalate: boolean; escalation_reason: string };
    try {
      parsed = JSON.parse(res.text);
    } catch {
      this.d.audit.record('jennifer', 'draft.unparseable', conversationId, { model: res.model });
      return undefined;
    }
    const cited = memories.filter((m) => parsed.cited_memory_ids.includes(m.entry.id) && m.freshness === 'current');
    const evidence: EvidenceRef[] = cited
      .filter((m) => m.entry.source.kind === 'bruno_statement' || m.entry.source.kind === 'official_record' || m.entry.source.kind === 'bruno_correction')
      .map((m) => ({ kind: 'memory', sourceId: m.entry.id, supports: detectClaims(m.entry.value) }));

    const payload: SendMessagePayload = {
      to: [replyTo.from.address],
      cc: [],
      bcc: [],
      subject: conv.channel === 'sms' ? undefined : replyTo.subject?.startsWith('Re:') ? replyTo.subject : `Re: ${replyTo.subject ?? ''}`,
      body: parsed.reply,
      attachmentIds: [],
      inReplyToMessageId: replyTo.id,
      evidence,
    };
    const intent = this.d.actions.propose({
      ownerId: this.d.ownerId,
      type: 'send_message',
      space: conv.space,
      channel: conv.channel === 'sms' ? 'sms' : 'email',
      connectorId: conv.channel === 'sms' ? 'sms' : this.connectorFor(conv.accountId),
      accountId: conv.accountId,
      conversationId,
      payload,
      proposedBy: 'jennifer',
    });
    // The model flagged it: never let a standing rule auto-send an escalation.
    if (parsed.escalate) this.d.actions.requireDecision(intent.id, 'jennifer', `escalated: ${parsed.escalation_reason}`);
    this.d.audit.record('jennifer', 'draft.created', intent.id, { model: res.model, promptVersion: res.promptVersion, cited: cited.map((c) => c.entry.id) });
    return intent;
  }

  private connectorFor(accountId: string): string {
    return accountId.startsWith('outlook:') ? 'outlook' : 'gmail';
  }
}
