/**
 * Shared domain vocabulary. Every private entity carries an owner and a scope
 * (space) so retrieval and attachment checks can filter before anything else.
 */

/** Separate project spaces (spec §2). A contact may belong to several. */
export const SPACES = ['personal', 'insurance', 'music', 'restaurant', 'nonprofit', 'technology'] as const;
export type Space = (typeof SPACES)[number];

/** The four action settings of the operating contract (spec §1). */
export const ACTION_MODES = ['observe', 'draft', 'execute', 'ask'] as const;
export type ActionMode = (typeof ACTION_MODES)[number];

export const SENSITIVITY_ORDER = ['normal', 'sensitive', 'restricted'] as const;
export type Sensitivity = (typeof SENSITIVITY_ORDER)[number];

export function sensitivityAllowed(entry: Sensitivity, max: Sensitivity): boolean {
  return SENSITIVITY_ORDER.indexOf(entry) <= SENSITIVITY_ORDER.indexOf(max);
}

export type Channel = 'email' | 'sms' | 'whatsapp' | 'voice' | 'calendar' | 'imessage' | 'social' | 'app';

export interface Owned {
  ownerId: string;
  space: Space;
}

/** Action types known to the authority registry. */
export const ACTION_TYPES = [
  'send_message',
  'create_draft',
  'create_event',
  'modify_event',
  'cancel_event',
  'place_call',
  'transfer_call',
  'transfer_money',
  'sign_contract',
  'change_account_security',
  'mass_outreach',
  'disclose_identity_document',
  'disclose_financial_document',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * Actions that are never covered by a generic template (spec §1): they need a
 * specifically configured authority rule with explicit limits, or a concrete
 * approval of the exact action.
 */
export const HIGH_RISK_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'transfer_money',
  'sign_contract',
  'change_account_security',
  'mass_outreach',
  'disclose_identity_document',
  'disclose_financial_document',
]);

export class JenniferError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JenniferError';
  }
}
