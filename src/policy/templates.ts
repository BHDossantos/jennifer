import type { ActionMode, ActionType, Space } from '../core/types.js';
import type { AuthorityRegistry, AuthorityRule } from './authority.js';

/**
 * Default operating-contract templates (spec §1). Nothing here is active
 * until Bruno enables a template for specific accounts/contacts; enabling
 * creates ordinary authority rules he can edit or revoke later.
 *
 * Money transfers, signatures, security changes, mass outreach and identity
 * or financial disclosure are deliberately absent: they need a specifically
 * configured rule or a concrete approval.
 */
export interface AuthorityTemplate {
  id: string;
  title: string;
  description: string;
  rules: Array<{ action: ActionType; mode: ActionMode; maxRecipients?: number }>;
  defaultExpiryDays?: number;
}

export const AUTHORITY_TEMPLATES: AuthorityTemplate[] = [
  {
    id: 'autopilot',
    title: 'Autopilot',
    description:
      'Reply automatically, in real time, to people you know (verified contacts) on the chosen accounts, and schedule or move meetings. Unknown senders, attachments, unsupported claims, money, contracts and security changes still come to you.',
    rules: [
      { action: 'send_message', mode: 'execute', maxRecipients: 3 },
      { action: 'create_event', mode: 'execute' },
      { action: 'modify_event', mode: 'execute' },
    ],
  },
  {
    id: 'routine_scheduling',
    title: 'Routine scheduling',
    description: 'Accept, propose and move meetings with chosen contacts, and send the matching short confirmations.',
    rules: [
      { action: 'create_event', mode: 'execute' },
      { action: 'modify_event', mode: 'execute' },
      { action: 'send_message', mode: 'execute', maxRecipients: 3 },
    ],
  },
  {
    id: 'administrative_replies',
    title: 'Administrative replies',
    description: 'Acknowledge receipt, confirm details already on record and ask clarifying questions. No commitments, payments or documents.',
    rules: [{ action: 'send_message', mode: 'execute', maxRecipients: 2 }],
  },
  {
    id: 'draft_only',
    title: 'Draft everything',
    description: 'Jennifer prepares replies and Bruno sends them.',
    rules: [
      { action: 'send_message', mode: 'draft' },
      { action: 'create_event', mode: 'ask' },
      { action: 'modify_event', mode: 'ask' },
    ],
  },
  {
    id: 'personal_relationship',
    title: 'Personal contact: ask first',
    description: 'For close personal contacts: Jennifer never sends on her own and follows contact-specific instructions.',
    rules: [{ action: 'send_message', mode: 'ask' }],
  },
  {
    id: 'observe_only',
    title: 'Observe only',
    description: 'Jennifer reads and summarizes but never drafts or acts.',
    rules: [{ action: 'send_message', mode: 'observe' }],
  },
];

export function enableTemplate(
  registry: AuthorityRegistry,
  templateId: string,
  principal: string,
  scope: { accountIds?: string[]; contactIds?: string[]; domains?: string[]; spaces?: Space[] },
  expiresAt?: Date,
): AuthorityRule[] {
  const t = AUTHORITY_TEMPLATES.find((x) => x.id === templateId);
  if (!t) throw new Error(`Unknown template ${templateId}`);
  if (!scope.accountIds?.length && !scope.contactIds?.length && !scope.domains?.length)
    throw new Error('Templates must be scoped to specific accounts, contacts or domains');
  return t.rules.map((r) =>
    registry.grant({
      principal,
      action: r.action,
      mode: r.mode,
      scope,
      limits: r.maxRecipients ? { maxRecipients: r.maxRecipients } : {},
      expiresAt,
      note: `template:${t.id}`,
    }),
  );
}
