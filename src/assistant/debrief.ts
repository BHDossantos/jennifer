import type { ActionService } from '../actions/service.js';
import type { ActionIntent } from '../actions/model.js';
import type { ConversationStore } from '../events/conversations.js';
import type { HandoffService } from './handoff.js';
import type { AuthorityRegistry } from '../policy/authority.js';

/**
 * "What did you do while I was busy?" Everything Jennifer sent (with the
 * exact text and why she was allowed to), every conversation she handled
 * for Bruno with the full exchange, and what is waiting for him. Built from
 * the action ledger and stored messages, never from the model's memory of
 * what it did.
 */
export interface Debrief {
  since: string;
  sent: Array<{ at: string; channel: string; to: string[]; subject?: string; text: string; authorizedBy: 'you approved it' | 'a conversation you handed me' | 'a standing permission' }>;
  handled: Array<{ with: string; channel: string; goal?: string; status: string; repliesSent: number; endedReason?: string; exchange: Array<{ at: string; who: string; text: string }> }>;
  needsYou: Array<{ actionId: string; what: string; to: string[]; preview: string; why: string }>;
  problems: Array<{ actionId: string; what: string; to: string[]; error: string }>;
  received: Record<string, number>;
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const toOf = (i: ActionIntent) => ((i.payload as { to?: string[] }).to ?? []);
const label = (i: ActionIntent) => (i.type === 'send_message' ? `${i.channel} message` : i.type === 'delegate_task' ? 'task for Claude' : i.type.replace(/_/g, ' '));

export function buildDebrief(d: { actions: ActionService; conversations: ConversationStore; handoffs: HandoffService; authority: AuthorityRegistry; ownerId: string }, since: Date): Debrief {
  const all = d.actions.list({ ownerId: d.ownerId });
  const handoffRules = new Map(d.handoffs.list().filter((h) => h.ruleId).map((h) => [h.ruleId!, h]));
  const sent: Debrief['sent'] = [];
  for (const i of all) {
    if (i.type !== 'send_message') continue;
    const at = i.history.find((h) => h.to === 'provider_accepted')?.at;
    if (!at || new Date(at) < since) continue;
    const p = i.payload as { to: string[]; subject?: string; body: string };
    sent.push({
      at: new Date(at).toISOString(),
      channel: i.channel,
      to: p.to,
      subject: p.subject,
      text: clip(p.body, 1200),
      authorizedBy: i.approvalId ? 'you approved it' : i.authorityRuleId && handoffRules.has(i.authorityRuleId) ? 'a conversation you handed me' : 'a standing permission',
    });
  }
  sent.sort((a, b) => a.at.localeCompare(b.at));

  const handled: Debrief['handled'] = [];
  for (const h of d.handoffs.list()) {
    if (h.status === 'awaiting_confirmation' || h.status === 'canceled') continue;
    const convs = d.conversations.listConversations(d.ownerId).filter((c) => c.participantContactIds.includes(h.contactId) && c.channel === h.channel);
    const messages = convs.flatMap((c) => d.conversations.messagesIn(c.id)).filter((m) => m.occurredAt >= new Date(h.createdAt)).sort((a, b) => +a.occurredAt - +b.occurredAt);
    const lastActivity = messages.at(-1)?.occurredAt ?? new Date(h.createdAt);
    if (lastActivity < since && h.status !== 'active') continue;
    handled.push({
      with: h.contactName,
      channel: h.channel,
      goal: h.goal,
      status: h.status,
      repliesSent: h.repliesSent,
      endedReason: h.endedReason,
      exchange: messages.slice(-30).map((m) => ({ at: m.occurredAt.toISOString(), who: m.direction === 'outbound' ? 'you (Jennifer)' : h.contactName, text: clip(m.body, 400) })),
    });
  }

  const needsYou = all
    .filter((i) => i.state === 'awaiting_decision')
    .map((i) => ({ actionId: i.id, what: label(i), to: toOf(i), preview: clip((i.payload as { body?: string; task?: string }).body ?? (i.payload as { task?: string }).task, 200), why: clip(i.stateReason ?? i.decisionReasons.join('; '), 200) }));
  const problems = all
    .filter((i) => (i.state === 'failed' || i.state === 'unknown') && i.history.at(-1) && new Date(i.history.at(-1)!.at) >= since)
    .map((i) => ({ actionId: i.id, what: label(i), to: toOf(i), error: clip(i.stateReason, 200) }));

  const received: Record<string, number> = {};
  for (const c of d.conversations.listConversations(d.ownerId))
    for (const m of d.conversations.messagesIn(c.id)) if (m.direction === 'inbound' && m.occurredAt >= since) received[m.channel] = (received[m.channel] ?? 0) + 1;

  return { since: since.toISOString(), sent, handled, needsYou, problems, received };
}
