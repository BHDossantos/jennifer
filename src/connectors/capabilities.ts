import type { Channel } from '../core/types.js';
import { type Clock } from '../core/util.js';

/** Each capability is recorded separately (spec §2). A login alone never means all functions work. */
export const CAPABILITIES = ['read', 'draft', 'send', 'attachment', 'webhook', 'history_import', 'search', 'delete', 'call'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityStatus = 'verified' | 'conditional' | 'unavailable' | 'disconnected';

export interface CapabilityRecord {
  status: CapabilityStatus;
  note?: string;
  verifiedAt?: Date;
}

export interface ConnectorDescriptor {
  id: string;
  provider: string;
  channel: Channel;
  accountId?: string;
  accountLabel?: string;
  accountType: string;
  docsUrl?: string;
  apiVersion?: string;
  requiredScopes: string[];
  appReview?: string;
  limits?: string;
  costs?: string;
  dataRegion?: string;
  reconnectProcedure?: string;
  capabilities: Record<Capability, CapabilityRecord>;
  connected: boolean;
  lastSuccessfulSyncAt?: Date;
  lastError?: string;
}

function caps(partial: Partial<Record<Capability, CapabilityStatus | [CapabilityStatus, string]>>): Record<Capability, CapabilityRecord> {
  const out = {} as Record<Capability, CapabilityRecord>;
  for (const c of CAPABILITIES) {
    const v = partial[c] ?? 'unavailable';
    out[c] = Array.isArray(v) ? { status: v[0], note: v[1] } : { status: v };
  }
  return out;
}

/**
 * Starting capability matrix. Nothing is marked "verified" until a real test
 * on Bruno's actual account passes; statuses here are the design-time
 * expectation ('conditional') or known limits ('unavailable').
 */
export function defaultConnectorCatalog(): ConnectorDescriptor[] {
  return [
    {
      id: 'gmail',
      provider: 'Gmail (IMAP IDLE + SMTP, Google app password)',
      channel: 'email',
      accountType: "Bruno's personal Gmail (2-Step Verification + app password)",
      docsUrl: 'https://support.google.com/accounts/answer/185833',
      requiredScopes: ['Full mailbox access (app passwords cannot be narrowed)'],
      appReview: 'None: no Google Cloud project. Google may restrict app passwords in future; the Gmail API path remains available if that happens.',
      limits: 'IMAP IDLE push with 5-minute safety poll; Gmail SMTP sending limits (~500 recipients/day for personal accounts).',
      reconnectProcedure: 'Create a new app password in Google Account → Security → App passwords, then Connections → Gmail → Connect. Revoking the app password in Google disconnects Jennifer.',
      capabilities: caps({
        read: ['conditional', 'IMAP sync from a saved cursor'],
        draft: ['conditional', 'Drafts placed in Gmail Drafts'],
        send: ['conditional', 'SMTP; reconciled via Sent Mail by Message-ID'],
        attachment: ['conditional', 'Metadata now; scanning before use'],
        webhook: ['conditional', 'IMAP IDLE push instead of Pub/Sub'],
        history_import: ['conditional', 'Explicit import only; no silent backfill'],
        search: 'conditional',
        delete: ['unavailable', 'Not built: Jennifer never deletes mail'],
      }),
      connected: false,
    },
    {
      id: 'outlook',
      provider: 'Microsoft Graph',
      channel: 'email',
      accountType: 'Microsoft 365 or Outlook.com',
      docsUrl: 'https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview',
      apiVersion: 'v1.0',
      requiredScopes: ['Mail.Read', 'Mail.Send (requested separately)', 'Calendars.ReadWrite'],
      limits: 'Subscriptions expire and require renewal plus lifecycle notification handling.',
      capabilities: caps({ read: 'conditional', draft: 'conditional', send: 'conditional', attachment: 'conditional', webhook: 'conditional', search: 'conditional' }),
      connected: false,
    },
    {
      id: 'google_calendar',
      provider: 'Google Calendar API',
      channel: 'calendar',
      accountType: 'Google account',
      requiredScopes: ['calendar.events', 'calendar.freebusy'],
      capabilities: caps({ read: 'conditional', send: ['conditional', 'Event create/modify'], webhook: 'conditional', search: 'conditional' }),
      connected: false,
    },
    {
      id: 'telephony',
      provider: 'API telephony provider + OpenAI Realtime SIP',
      channel: 'voice',
      accountType: 'Dedicated test number or approved forwarded number',
      docsUrl: 'https://developers.openai.com/api/docs/guides/voice-sip',
      requiredScopes: [],
      appReview: 'Regional sender registration and carrier restrictions; legal review of recording and automated calling (IT, US).',
      reconnectProcedure:
        "Do not port Bruno's AT&T number. Use AT&T conditional forwarding to Jennifer's provider number: no answer **61*<n>#, busy **67*<n>#, unreachable **62*<n>#. Roll back with ##61#, ##67#, ##62#; check with *#61#. Forwarding moves calls only, never SMS. See docs/SETUP_DESIGN.md.",
      capabilities: caps({ call: 'conditional', read: ['conditional', 'SMS receive on provider number only'], send: ['conditional', 'SMS send on provider number only'], webhook: 'conditional' }),
      connected: false,
    },
    {
      id: 'whatsapp_business',
      provider: 'WhatsApp Business Platform (via Twilio or Meta)',
      channel: 'whatsapp',
      accountType: 'Eligible business number only',
      docsUrl: 'https://www.twilio.com/docs/whatsapp/tutorial/send-whatsapp-notification-messages-templates',
      requiredScopes: [],
      limits: '24h customer service window; approved templates required outside it. Enforced in adapter.',
      capabilities: caps({ read: 'conditional', send: ['conditional', 'Window/template rules enforced in adapter'], webhook: 'conditional' }),
      connected: false,
    },
    {
      id: 'whatsapp_personal',
      provider: 'WhatsApp personal inbox',
      channel: 'whatsapp',
      accountType: 'Personal account',
      requiredScopes: [],
      capabilities: caps({ draft: ['conditional', 'User-initiated draft handoff only'] }),
      connected: false,
      lastError: 'No supported API for a personal WhatsApp inbox. Unsupported, not pending.',
    },
    {
      id: 'imessage',
      provider: 'Apple iMessage / SMS on iPhone',
      channel: 'imessage',
      accountType: "Bruno's iPhone",
      docsUrl: 'https://developer.apple.com/documentation/telephonymessagingkit',
      requiredScopes: [],
      appReview: 'Entitlement, region and OS availability not established; real-device feasibility test on the iPhone 17 Pro Max required.',
      capabilities: caps({ draft: ['conditional', 'Share sheet / draft handoff where the OS supports it'] }),
      connected: false,
      lastError:
        'iOS gives third-party apps no access to the Messages inbox. AT&T forwarding does not forward SMS. Jennifer can prepare a text you send yourself, but cannot read or send iMessage/SMS on your personal number.',
    },
    {
      id: 'ios_app',
      provider: 'Jennifer iOS app (React Native + Swift modules)',
      channel: 'app',
      accountType: "Bruno's iPhone 17 Pro Max (AT&T)",
      requiredScopes: ['Microphone', 'Notifications', 'Speech (optional)'],
      appReview: 'Apple Developer Program, TestFlight distribution; CallKit/PushKit for app-to-app voice calls.',
      capabilities: caps({
        read: ['conditional', 'Push notifications and in-app inbox for Jennifer items'],
        draft: ['conditional', 'Share extension: send text, links and files to Jennifer'],
        send: ['conditional', 'Messages composer handoff: Bruno taps send himself'],
        call: ['conditional', 'Push-to-talk voice session; App Intents for Siri and Shortcuts ("Ask Jennifer")'],
      }),
      connected: false,
    },
    {
      id: 'workforce',
      provider: 'Bruno AI Workforce (REST API + signed webhooks)',
      channel: 'app',
      accountType: 'Dedicated read-only viewer service user',
      docsUrl: 'docs/WORKFORCE_ASSESSMENT.md',
      requiredScopes: ['viewer'],
      appReview: 'Fix unsigned carrier webhooks and plaintext runtime secrets in Workforce before connecting.',
      capabilities: caps({
        read: ['conditional', 'Leads, conversation outcomes, jobs, music drafts, CEO brief'],
        webhook: ['conditional', 'lead.replied, client.* (HMAC X-Bruno-Signature)'],
        search: 'conditional',
        send: ['unavailable', 'By design: Jennifer never sends through Workforce'],
      }),
      connected: false,
    },
    ...['instagram', 'facebook', 'linkedin', 'x', 'telegram'].map<ConnectorDescriptor>((id) => ({
      id,
      provider: id,
      channel: 'social',
      accountType: 'To be determined per account type and approved permissions',
      requiredScopes: [],
      capabilities: caps({ draft: ['conditional', 'User-initiated draft workflow'] }),
      connected: false,
      lastError: 'Capability investigation pending; DM access depends on account type and provider approval.',
    })),
  ];
}

/** Live capability screen backing store (spec §2 definition of done). */
export class CapabilityRegistry {
  private connectors = new Map<string, ConnectorDescriptor>();
  constructor(
    private clock: Clock,
    catalog: ConnectorDescriptor[] = defaultConnectorCatalog(),
  ) {
    for (const c of catalog) this.connectors.set(c.id, c);
  }

  get(id: string): ConnectorDescriptor | undefined {
    return this.connectors.get(id);
  }

  list(): ConnectorDescriptor[] {
    return [...this.connectors.values()];
  }

  upsert(c: ConnectorDescriptor): void {
    this.connectors.set(c.id, c);
  }

  markVerified(id: string, capability: Capability, note?: string): void {
    const c = this.require(id);
    c.capabilities[capability] = { status: 'verified', note, verifiedAt: this.clock.now() };
  }

  markConnected(id: string, accountId: string, accountLabel?: string): void {
    const c = this.require(id);
    c.connected = true;
    c.accountId = accountId;
    c.accountLabel = accountLabel;
    c.lastError = undefined;
    for (const cap of CAPABILITIES) if (c.capabilities[cap].status === 'disconnected') c.capabilities[cap].status = 'conditional';
  }

  markDisconnected(id: string, error: string): void {
    const c = this.require(id);
    c.connected = false;
    c.lastError = error;
    for (const cap of CAPABILITIES) if (c.capabilities[cap].status !== 'unavailable') c.capabilities[cap].status = 'disconnected';
  }

  recordSync(id: string): void {
    this.require(id).lastSuccessfulSyncAt = this.clock.now();
  }

  can(id: string, cap: Capability): boolean {
    const c = this.connectors.get(id);
    if (!c || !c.connected) return false;
    const s = c.capabilities[cap].status;
    return s === 'verified' || s === 'conditional';
  }

  /** Plain-language summary used by the Connections screen. */
  screen(): Array<{ id: string; provider: string; account?: string; connected: boolean; canMonitor: boolean; actions: string[]; unavailable: string[]; lastSync?: string; problem?: string }> {
    return this.list().map((c) => ({
      id: c.id,
      provider: c.provider,
      account: c.accountLabel,
      connected: c.connected,
      canMonitor: c.connected && ['verified', 'conditional'].includes(c.capabilities.read.status),
      actions: CAPABILITIES.filter((k) => c.connected && ['verified', 'conditional'].includes(c.capabilities[k].status)).map(
        (k) => `${k}${c.capabilities[k].status === 'verified' ? '' : ' (not yet verified)'}`,
      ),
      unavailable: CAPABILITIES.filter((k) => c.capabilities[k].status === 'unavailable'),
      lastSync: c.lastSuccessfulSyncAt?.toISOString(),
      problem: c.lastError,
    }));
  }

  private require(id: string): ConnectorDescriptor {
    const c = this.connectors.get(id);
    if (!c) throw new Error(`Unknown connector ${id}`);
    return c;
  }
}
