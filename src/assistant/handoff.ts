import { JenniferError, type Channel } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import type { SettingsStore } from '../core/settings.js';
import type { AuditLog } from '../audit/audit.js';
import type { ActionService } from '../actions/service.js';
import type { ActionIntent } from '../actions/model.js';
import type { AuthorityRegistry } from '../policy/authority.js';
import type { Contact, ContactDirectory, IdentityKind } from '../contacts/contacts.js';
import type { CapabilityRegistry } from '../connectors/capabilities.js';
import type { ConversationStore } from '../events/conversations.js';

/**
 * "Hey Jennifer, text my sister and sort out dinner" (Jarvis mode).
 *
 * 1. Bruno asks Jennifer to message someone. She resolves who (never a
 *    guess), picks the channel, and reads the exact text back.
 * 2. Bruno says "yes": the opener is approved and sent (starting a
 *    conversation always needs his word).
 * 3. If he asked her to handle it, Jennifer gets a narrow standing permission:
 *    replies only, to that one person, on that one channel, for a limited
 *    time and number of messages, pursuing the goal he gave. Anything outside
 *    the goal, money, documents or a "who is this?" goes back to him.
 * 4. It ends when the goal is reached, the limits run out, Bruno replies
 *    himself, or he says stop. The debrief shows everything that was said.
 */
export type HandoffStatus = 'awaiting_confirmation' | 'active' | 'done' | 'stopped' | 'expired' | 'canceled';

export interface Handoff {
  id: string;
  contactId: string;
  contactName: string;
  channel: Channel;
  accountId: string;
  address: string;
  goal?: string;
  openerActionId: string;
  handleReplies: boolean;
  createdAt: string;
  expiresAt: string;
  maxReplies: number;
  repliesSent: number;
  status: HandoffStatus;
  ruleId?: string;
  endedReason?: string;
  /** Exact opener version Bruno heard. */
  revision?: number;
  payloadHash?: string;
  conversationId?: string;
}

const RELATIONS = ['sister', 'brother', 'mom', 'mother', 'mum', 'dad', 'father', 'wife', 'husband', 'girlfriend', 'boyfriend', 'partner', 'son', 'daughter', 'aunt', 'uncle', 'cousin', 'grandma', 'grandmother', 'grandpa', 'grandfather', 'assistant', 'accountant', 'lawyer', 'doctor', 'friend'];

export interface HandoffDeps {
  clock: Clock;
  settings: SettingsStore;
  audit: AuditLog;
  actions: ActionService;
  authority: AuthorityRegistry;
  contacts: ContactDirectory;
  capabilities: CapabilityRegistry;
  conversations: ConversationStore;
  ownerId: string;
  notify?: (title: string, body: string) => Promise<unknown>;
}

/** A short, unhedged yes in Bruno's own words ("yes", "send it", "go ahead", "sim, manda"). */
export function isAffirmative(words: string | undefined): boolean {
  const t = (words ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 8) return false;
  if (/\b(no|nope|don't|dont|do not|wait|hold|stop|cancel|change|not yet|later|nao|não)\b/.test(t)) return false;
  return /^(hey jennifer |jennifer )?(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|correct|send|send it|go|go ahead|do it|perfect|sounds good|sim|si|sì|claro|manda|vai)\b/.test(t);
}

export class HandoffService {
  private items: Handoff[] = [];
  private loaded: Promise<void>;

  constructor(private d: HandoffDeps) {
    this.loaded = d.settings.get<Handoff[]>('handoffs').then((v) => {
      this.items = v ?? [];
    });
    d.actions.onTransition((intent) => void this.onTransition(intent).catch(() => undefined));
  }

  async ready() {
    await this.loaded;
  }

  private async save() {
    await this.d.settings.set('handoffs', this.items);
  }

  list(): Handoff[] {
    return this.items.map((h) => ({ ...h }));
  }

  get(id: string): Handoff {
    const h = this.items.find((x) => x.id === id);
    if (!h) throw new JenniferError('handoff.not_found', `No handoff ${id}`);
    return h;
  }

  /** Who is "my sister" / "Ana"? Exact names, then relationships Bruno recorded on the contact. Never a guess. */
  findContacts(who: string): Contact[] {
    const q = who.trim().toLowerCase().replace(/^(my|our)\s+/, '');
    const all = this.d.contacts.list(this.d.ownerId);
    const byName = all.filter((c) => c.displayName.toLowerCase() === q || c.displayName.toLowerCase().split(/\s+/)[0] === q);
    if (byName.length) return byName;
    if (RELATIONS.includes(q)) return all.filter((c) => new RegExp(`\\b${q}\\b`, 'i').test(c.instructions ?? ''));
    const byIdentity = all.filter((c) => c.identities.some((i) => i.value.toLowerCase() === q || i.value.replace(/[^\d+]/g, '') === q.replace(/[^\d+]/g, '')));
    return byIdentity;
  }

  /** Best channel to reach a contact as Bruno: his iMessage, then email, then WhatsApp Business, then Jennifer's SMS number. */
  private route(c: Contact, preferred?: Channel): { channel: Channel; connectorId: string; accountId: string; address: string } | { error: string } {
    const verified = (kind: IdentityKind) => c.identities.find((i) => i.kind === kind && i.verified)?.value;
    const phone = verified('phone');
    const email = verified('email');
    const wa = verified('whatsapp') ?? phone;
    const can = (id: string) => this.d.capabilities.can(id, 'send');
    const options: Array<{ channel: Channel; connectorId: string; address?: string }> = [
      { channel: 'imessage', connectorId: 'imessage', address: phone ?? email },
      { channel: 'email', connectorId: 'gmail', address: email },
      { channel: 'whatsapp', connectorId: 'whatsapp_business', address: wa },
      { channel: 'sms', connectorId: 'sms', address: phone },
    ];
    const ordered = preferred ? [...options.filter((o) => o.channel === preferred), ...options.filter((o) => o.channel !== preferred)] : options;
    for (const o of ordered) {
      if (!o.address || !can(o.connectorId)) continue;
      if (preferred && o.channel !== preferred) return { error: `I can't reach ${c.displayName} by ${preferred} (not connected or no verified ${preferred === 'email' ? 'email' : 'number'}). I could use ${o.channel} instead.` };
      const accountId = this.d.capabilities.get(o.connectorId)?.accountId ?? `${o.connectorId}:default`;
      return { channel: o.channel, connectorId: o.connectorId, accountId, address: o.address };
    }
    return { error: `I have no connected channel with a verified address for ${c.displayName}. Connect iMessage (your Mac) or Gmail, or tell me their number/email.` };
  }

  /** Step 1: draft the opener and read it back. Nothing is sent until Bruno confirms. */
  async propose(input: { who: string; message: string; channel?: Channel; handleReplies: boolean; goal?: string; hours?: number; maxReplies?: number; proposedBy: string }) {
    await this.loaded;
    const found = this.findContacts(input.who);
    if (found.length === 0) return { ok: false as const, needs: 'contact', question: `I don't know who "${input.who}" is yet. What's their name and number or email? (Say e.g. "my sister is Ana, +1 305 555 0100".)` };
    if (found.length > 1) return { ok: false as const, needs: 'which', question: `I know ${found.length} people matching "${input.who}": ${found.map((c) => c.displayName).join(', ')}. Which one?` };
    const contact = found[0]!;
    const r = this.route(contact, input.channel);
    if ('error' in r) return { ok: false as const, needs: 'channel', question: r.error };
    const hours = Math.min(Math.max(input.hours ?? 24, 1), 72);
    const now = this.d.clock.now();
    // Start (or reuse) the thread the replies will arrive in, so Jennifer sees her own opener when she answers.
    const thread = r.channel === 'imessage' ? `imessage:any;-;${r.address}` : r.channel === 'whatsapp' ? `whatsapp:${r.address.replace(/^\+/, '')}` : r.channel === 'sms' ? `sms:${r.address}` : undefined;
    const conv = thread
      ? this.d.conversations.upsertConversation({ ownerId: this.d.ownerId, accountId: r.accountId, channel: r.channel, space: 'personal', providerThreadId: thread, participantContactIds: [contact.id] })
      : undefined;
    const intent = this.d.actions.propose({
      ownerId: this.d.ownerId,
      type: 'send_message',
      space: 'personal',
      channel: r.channel,
      connectorId: r.connectorId,
      accountId: r.accountId,
      conversationId: conv?.id,
      payload: { to: [r.address], cc: [], bcc: [], subject: r.channel === 'email' ? (input.goal ?? 'Hi').slice(0, 80) : undefined, body: input.message.trim(), attachmentIds: [], evidence: [] },
      proposedBy: input.proposedBy,
    });
    // Starting a conversation always waits for Bruno's word, whatever standing rules say.
    if (intent.state !== 'awaiting_decision' && intent.state !== 'failed' && intent.state !== 'canceled') this.d.actions.requireDecision(intent.id, 'jennifer', 'new conversation: Bruno confirms the opener');
    const h: Handoff = {
      id: newId('ho'),
      contactId: contact.id,
      contactName: contact.displayName,
      channel: r.channel,
      accountId: r.accountId,
      address: r.address,
      goal: input.goal?.trim() || undefined,
      openerActionId: intent.id,
      handleReplies: input.handleReplies,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + hours * 3600_000).toISOString(),
      maxReplies: Math.min(Math.max(input.maxReplies ?? 15, 1), 40),
      repliesSent: 0,
      status: 'awaiting_confirmation',
      revision: this.d.actions.get(intent.id).revision,
      payloadHash: this.d.actions.get(intent.id).payloadHash,
    };
    this.items.push(h);
    await this.save();
    this.d.audit.record('jennifer', 'handoff.proposed', h.id, { contactId: contact.id, channel: r.channel, handleReplies: h.handleReplies });
    const current = this.d.actions.get(intent.id);
    return {
      ok: true as const,
      handoffId: h.id,
      actionId: intent.id,
      state: current.state,
      blockers: current.state === 'failed' || current.state === 'canceled' ? current.decisionReasons : undefined,
      readback: `${r.channel === 'imessage' ? 'iMessage' : r.channel === 'email' ? 'Email' : r.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} to ${contact.displayName} (${r.address}): "${input.message.trim()}"${h.handleReplies ? ` Then I'll handle the replies for up to ${hours} h${h.goal ? `, aiming to: ${h.goal}` : ''}.` : ''} Shall I send it?`,
    };
  }

  /**
   * Step 2: Bruno said yes. The yes must be his own words (never the
   * model's), arrive after the read-back, and the text must be unchanged
   * since he heard it.
   */
  confirm(input: { handoffId?: string; ownerWords?: string; ownerWordsAt?: Date }) {
    if (!isAffirmative(input.ownerWords)) throw new JenniferError('handoff.needs_yes', 'I need a clear yes from you before I send it.');
    const waiting = this.items.filter((x) => x.status === 'awaiting_confirmation' && (!input.handoffId || x.id === input.handoffId));
    const heardAt = (input.ownerWordsAt ?? this.d.clock.now()).getTime();
    const h = waiting.filter((x) => Date.parse(x.createdAt) < heardAt && heardAt - Date.parse(x.createdAt) < 15 * 60_000).at(-1);
    if (!h) throw new JenniferError('handoff.nothing_to_confirm', 'There is no message waiting for your yes.');
    const a = this.d.actions.get(h.openerActionId);
    if (a.state !== 'awaiting_decision') throw new JenniferError('handoff.nothing_to_confirm', `That message is ${a.state}, not waiting for you.`);
    if (a.revision !== h.revision || a.payloadHash !== h.payloadHash) throw new JenniferError('handoff.changed', 'The message changed after I read it to you; let me read it again.');
    this.d.actions.approve(a.id, this.d.ownerId, { revision: a.revision, payloadHash: a.payloadHash });
    this.d.audit.record(this.d.ownerId, 'handoff.confirmed', h.id, { by: 'owner_words' });
    return h;
  }

  /** "My sister is Ana, +1 305 555 0100": only numbers/emails Bruno actually said are saved. */
  saveContact(input: { name: string; phone?: string; email?: string; relation?: string; ownerWords?: string }) {
    const words = (input.ownerWords ?? '').toLowerCase();
    const digits = (v: string) => v.replace(/[^\d]/g, '');
    if (!input.phone && !input.email) throw new JenniferError('contact.needs_address', 'I need their number or email.');
    if (input.phone && (digits(input.phone).length < 7 || !digits(words).includes(digits(input.phone).slice(-7)))) throw new JenniferError('contact.not_from_bruno', 'Please say or type the number yourself so I save exactly what you said.');
    if (input.email && !words.includes(input.email.toLowerCase())) throw new JenniferError('contact.not_from_bruno', 'Please type the email address yourself so I save exactly what you said.');
    if (!words.includes(input.name.toLowerCase().split(/\s+/)[0]!)) throw new JenniferError('contact.not_from_bruno', 'Tell me their name in your own words.');
    const relation = input.relation?.toLowerCase().trim();
    const note = relation ? `Bruno's ${relation}` : undefined;
    const ident = input.phone ? { kind: 'phone' as const, value: input.phone } : { kind: 'email' as const, value: input.email! };
    const c = this.d.contacts.learnFromApproval(this.d.ownerId, ident.kind, ident.value, 'personal', input.name);
    const instructions = note && !(c.instructions ?? '').toLowerCase().includes(note.toLowerCase()) ? [c.instructions, note].filter(Boolean).join('. ') : c.instructions;
    this.d.contacts.update(c.id, { displayName: input.name, instructions, relationship: 'personal' });
    if (input.phone && input.email) this.d.contacts.update(c.id, { addIdentity: { kind: 'email', value: input.email.toLowerCase(), verified: true, source: 'bruno-stated' } });
    this.d.audit.record(this.d.ownerId, 'contact.saved_by_voice', c.id, { relation });
    return { contactId: c.id, name: input.name, relation };
  }

  /** Context for drafting a reply inside an active handoff. */
  contextFor(contactId: string | undefined): string | undefined {
    if (!contactId) return undefined;
    const h = this.items.find((x) => x.contactId === contactId && x.status === 'active');
    if (!h) return undefined;
    return [
      `Bruno asked you to handle this conversation with ${h.contactName} for him.`,
      h.goal ? `His goal: ${h.goal}. Pursue it naturally; when it is achieved, wrap up warmly.` : 'Keep it friendly and brief.',
      'Never invent plans, promises, money matters or facts Bruno did not give you. If they ask for something outside the goal, or anything sensitive, set escalate=true so Bruno decides.',
      'If they ask whether they are talking to Bruno or to an AI, answer honestly that Jennifer, Bruno\'s assistant, is helping him reply, and set escalate=true.',
    ].join(' ');
  }

  async stop(id: string, reason = 'stopped by Bruno', status: HandoffStatus = 'stopped') {
    const h = this.get(id);
    if (h.status !== 'active' && h.status !== 'awaiting_confirmation') return h;
    if (h.ruleId) this.d.authority.revoke(h.ruleId, this.d.ownerId);
    if (h.status === 'awaiting_confirmation') this.d.actions.cancel(h.openerActionId, this.d.ownerId, reason);
    h.status = h.status === 'awaiting_confirmation' ? 'canceled' : status;
    h.endedReason = reason;
    await this.save();
    this.d.audit.record('jennifer', 'handoff.ended', h.id, { status: h.status, reason });
    return h;
  }

  /** Bruno replied himself in that thread: he has taken over. */
  async onManualReply(conversationId: string) {
    const conv = this.d.conversations.getConversation(conversationId);
    for (const h of this.items.filter((x) => x.status === 'active' && conv.participantContactIds.includes(x.contactId))) {
      await this.stop(h.id, 'you replied yourself, so I stepped back', 'stopped');
      await this.d.notify?.(`You took over with ${h.contactName}`, 'I stopped replying in that conversation.');
    }
  }

  /** Expire handoffs past their time. Called by the scheduler. */
  async tick() {
    const now = this.d.clock.now().getTime();
    for (const h of this.items.filter((x) => (x.status === 'active' || x.status === 'awaiting_confirmation') && Date.parse(x.expiresAt) <= now)) {
      await this.stop(h.id, 'time limit reached', 'expired');
      if (h.status === 'expired') await this.d.notify?.(`Conversation with ${h.contactName} handed back`, 'The time you gave me is up; anything new waits for you.');
    }
  }

  private async onTransition(intent: ActionIntent) {
    if (intent.type !== 'send_message' || intent.state !== 'provider_accepted') return;
    const opener = this.items.find((x) => x.openerActionId === intent.id && x.status === 'awaiting_confirmation');
    if (opener) {
      opener.conversationId = intent.conversationId;
      if (opener.handleReplies) {
        // A narrow standing permission: replies only, this person, this account, until the deadline.
        const rule = this.d.authority.grant({
          principal: this.d.ownerId,
          action: 'send_message',
          mode: 'execute',
          scope: { contactIds: [opener.contactId], accountIds: [opener.accountId] },
          limits: { maxRecipients: 1 },
          expiresAt: new Date(opener.expiresAt),
          note: `handoff:${opener.id}`,
        });
        opener.ruleId = rule.id;
        opener.status = 'active';
      } else {
        opener.status = 'done';
        opener.endedReason = 'message sent';
      }
      await this.save();
      return;
    }
    const h = this.items.find((x) => x.status === 'active' && x.ruleId && intent.authorityRuleId === x.ruleId);
    if (!h) return;
    h.repliesSent++;
    if (h.repliesSent >= h.maxReplies) {
      await this.stop(h.id, `reached ${h.maxReplies} replies`, 'done');
      await this.d.notify?.(`Conversation with ${h.contactName} handed back`, `I sent ${h.repliesSent} replies; the next one waits for you.`);
    } else await this.save();
  }
}
