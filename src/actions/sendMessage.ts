import type { Space } from '../core/types.js';
import { type Clock, systemClock } from '../core/util.js';
import type { ContactDirectory, IdentityKind } from '../contacts/contacts.js';
import type { ConversationStore } from '../events/conversations.js';
import type { MessagingConnector } from '../connectors/connector.js';
import type { CapabilityRegistry } from '../connectors/capabilities.js';
import { type EvidenceRef, unsupportedClaims } from '../security/claims.js';
import type { ActionHandler, ActionIntent, PerformResult, ResolvedAction } from './model.js';

/**
 * Illustrative send contract from spec §15. The server validates recipients,
 * attachment scope, thread revision, policy, revocation and payload hash
 * before the connector receives the request.
 */
export interface SendMessagePayload {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  body: string;
  attachmentIds: string[];
  inReplyToMessageId?: string;
  /** Evidence backing factual claims in the body. */
  evidence: EvidenceRef[];
  amountEur?: number;
}

export class SendMessageHandler implements ActionHandler<SendMessagePayload> {
  readonly type = 'send_message' as const;

  constructor(
    private contacts: ContactDirectory,
    private conversations: ConversationStore,
    private connectors: Map<string, MessagingConnector>,
    private capabilities: CapabilityRegistry,
    private opts: {
      clock?: Clock;
      /** Sandbox mode: hard-block every recipient not on this list (first live tests). */
      sandboxRecipients?: string[];
    } = {},
  ) {}

  resolve(intent: ActionIntent<SendMessagePayload>): ResolvedAction {
    const p = intent.payload;
    const violations: string[] = [];
    const concerns: string[] = [];
    const addresses = [...p.to, ...p.cc, ...p.bcc].map((a) => a.toLowerCase());
    const contactIds: string[] = [];

    if (addresses.length === 0) violations.push('no recipients');
    if (this.opts.sandboxRecipients) {
      const allowed = new Set(this.opts.sandboxRecipients.map((a) => a.toLowerCase()));
      const blocked = addresses.filter((a) => !allowed.has(a));
      if (blocked.length) violations.push(`sandbox mode: ${blocked.join(', ')} not on the test recipient list`);
    }
    if (!this.capabilities.can(intent.connectorId, 'send')) violations.push(`connector ${intent.connectorId} cannot send (disconnected or unsupported)`);

    const kindOf = (addr: string): IdentityKind => (intent.channel === 'email' || (intent.channel === 'imessage' && addr.includes('@')) ? 'email' : intent.channel === 'whatsapp' ? 'whatsapp' : 'phone');
    for (const addr of addresses) {
      let kind: IdentityKind = kindOf(addr);
      let c = this.contacts.findByIdentity(intent.ownerId, kind, addr);
      // WhatsApp contacts are often saved by phone number.
      if (!c && kind === 'whatsapp' && (c = this.contacts.findByIdentity(intent.ownerId, 'phone', addr))) kind = 'phone';
      if (!c) {
        concerns.push(`recipient ${addr} is not a known contact`);
        continue;
      }
      contactIds.push(c.id);
      const ident = c.identities.find((i) => i.kind === kind && i.value === addr);
      if (!ident?.verified) concerns.push(`recipient ${addr} is not a verified identity for ${c.displayName}`);
      if (!c.spaces.includes(intent.space)) concerns.push(`${c.displayName} is not part of the ${intent.space} space`);
    }

    const attachmentSpaces: Space[] = [];
    for (const id of p.attachmentIds) {
      let a;
      try {
        a = this.conversations.getAttachment(id);
      } catch {
        violations.push(`attachment ${id} does not exist`);
        continue;
      }
      if (a.ownerId !== intent.ownerId) violations.push(`attachment ${id} belongs to another owner`);
      if (a.space !== intent.space) violations.push(`attachment ${a.filename} belongs to the ${a.space} space, not ${intent.space}`);
      if (a.scanStatus !== 'clean') violations.push(`attachment ${a.filename} has not passed scanning`);
      if (a.shareableWithContactIds && contactIds.some((c) => !a.shareableWithContactIds!.includes(c)))
        violations.push(`attachment ${a.filename} is not permitted for these recipients`);
      if (a.sensitivity !== 'normal') concerns.push(`attachment ${a.filename} is ${a.sensitivity}`);
      attachmentSpaces.push(a.space);
    }

    const claims = unsupportedClaims(p.body, p.evidence);
    if (claims.length) concerns.push(`unsupported factual claims: ${claims.join(', ')}`);

    // A reply = the conversation already has a message from every recipient.
    let isReply = false;
    if (intent.conversationId) {
      const conv = this.conversations.getConversation(intent.conversationId);
      if (conv.ownerId !== intent.ownerId || conv.accountId !== intent.accountId) violations.push('conversation does not belong to this account');
      const wrote = new Set(this.conversations.messagesIn(conv.id).filter((m) => m.direction === 'inbound').map((m) => m.from.address.toLowerCase()));
      isReply = addresses.length > 0 && addresses.every((a) => wrote.has(a));
    }

    return {
      authority: {
        action: 'send_message',
        accountId: intent.accountId,
        space: intent.space,
        contactIds,
        recipientDomains: addresses.map((a) => a.split('@')[1] ?? '').filter(Boolean),
        workflowId: intent.workflowId,
        amountEur: p.amountEur,
        attachmentSpaces,
        recipientCount: addresses.length,
        isReply,
      },
      contactIds,
      addresses,
      violations,
      concerns,
    };
  }

  async perform(intent: ActionIntent<SendMessagePayload>): Promise<PerformResult> {
    const connector = this.connectors.get(intent.connectorId);
    if (!connector) return { kind: 'rejected', error: `connector ${intent.connectorId} not configured`, retryable: false };
    const p = intent.payload;
    const conv = intent.conversationId ? this.conversations.getConversation(intent.conversationId) : undefined;
    const replyTo = p.inReplyToMessageId ? this.conversations.getMessage(p.inReplyToMessageId) : undefined;
    const res = await connector.send({
      accountId: intent.accountId,
      conversationId: intent.conversationId ?? '',
      providerThreadId: conv?.providerThreadId,
      inReplyToProviderMessageId: replyTo?.providerMessageId,
      replyHeaders: replyHeadersFor(replyTo),
      to: p.to,
      cc: p.cc,
      bcc: p.bcc,
      subject: p.subject,
      body: p.body,
      attachments: p.attachmentIds.map((id) => {
        const a = this.conversations.getAttachment(id);
        return { id, filename: a.filename, storageRef: a.storageRef };
      }),
      idempotencyKey: intent.idempotencyKey,
    });
    if (res.kind === 'timeout') return { kind: 'ambiguous', error: 'provider timed out after a possible send' };
    if (res.kind === 'rejected') {
      if (/invalid_grant|revoked|unauthori[sz]ed|app password/i.test(res.error)) this.capabilities.markDisconnected(intent.connectorId, res.error);
      return res;
    }
    if (conv) {
      this.conversations.addMessage({
        ownerId: intent.ownerId,
        accountId: intent.accountId,
        conversationId: conv.id,
        providerMessageId: res.providerMessageId,
        providerThreadId: conv.providerThreadId,
        direction: 'outbound',
        channel: intent.channel,
        status: 'provider_accepted',
        from: { address: intent.accountId },
        to: p.to,
        cc: p.cc,
        bcc: p.bcc,
        subject: p.subject,
        body: p.body,
        headers: { 'X-Jennifer-Action': intent.id },
        attachmentIds: p.attachmentIds,
        occurredAt: (this.opts.clock ?? systemClock).now(),
        flags: [],
      });
    }
    return { kind: 'accepted', receipt: { providerMessageId: res.providerMessageId, deliveryStatus: res.deliveryStatus, evidence: `provider ${connector.id} accepted` } };
  }

  async reconcile(intent: ActionIntent<SendMessagePayload>) {
    const connector = this.connectors.get(intent.connectorId);
    const found = await connector?.findByIdempotencyKey(intent.accountId, intent.idempotencyKey);
    if (!found) {
      const attemptedAt = [...intent.history].reverse().find((h) => h.to === 'executing')?.at;
      const age = attemptedAt ? (this.opts.clock ?? systemClock).now().getTime() - attemptedAt.getTime() : Infinity;
      if (age < (connector?.reconcileGraceMs ?? 0)) return { found: 'pending' as const };
      return { found: false as const };
    }
    return { found: true as const, receipt: { providerMessageId: found.providerMessageId, deliveryStatus: 'accepted' as const, evidence: 'found in provider sent records during reconciliation' } };
  }
}

function replyHeadersFor(m: { headers: Record<string, string> } | undefined): { inReplyTo: string; references: string[] } | undefined {
  const id = m?.headers['message-id']?.trim().replace(/^<|>$/g, '');
  if (!id) return undefined;
  const refs = (m!.headers['references'] ?? '').split(/\s+/).map((r) => r.replace(/^<|>$/g, '')).filter(Boolean);
  return { inReplyTo: id, references: [...refs, id] };
}
