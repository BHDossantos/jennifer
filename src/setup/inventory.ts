import { z } from 'zod';
import { SPACES } from '../core/types.js';

/**
 * Account and device inventory (spec §2, Week 1). Captures what Jennifer may
 * connect to and surfaces the blockers that keep a capability from being
 * verified. Unknown values stay explicit (null), never guessed.
 */
const Unknown = z.null();

export const InventorySchema = z.object({
  updatedAt: z.string(),
  owner: z.object({
    name: z.string(),
    homeTimeZone: z.string(),
    countries: z.array(z.string()),
    languages: z.array(z.string()),
  }),
  phone: z.object({
    model: z.string(),
    os: z.enum(['iOS', 'Android']),
    osVersion: z.string().or(Unknown),
    appStoreRegion: z.string().or(Unknown),
    carrier: z.string(),
    carrierCountry: z.string(),
    numbers: z.array(z.object({ e164: z.string(), label: z.string(), kind: z.enum(['personal', 'business']) })),
    eSim: z.boolean().or(Unknown),
  }),
  email: z.array(z.object({ provider: z.enum(['gmail', 'google_workspace', 'outlook', 'icloud', 'other']), address: z.string(), space: z.enum(SPACES), sendAllowed: z.boolean() })),
  calendars: z.array(z.object({ provider: z.string(), id: z.string(), space: z.enum(SPACES) })),
  messaging: z.array(z.object({ service: z.string(), accountType: z.enum(['personal', 'business']), handle: z.string().or(Unknown) })),
  social: z.array(z.object({ network: z.string(), handle: z.string(), accountType: z.enum(['personal', 'business', 'creator']), space: z.enum(SPACES) })),
  desktops: z.array(z.object({ os: z.string(), use: z.string() })),
  existingAssistantCode: z.array(z.object({ repo: z.string(), assessment: z.string(), reuse: z.string() })),
});
export type Inventory = z.infer<typeof InventorySchema>;

export interface Blocker {
  area: string;
  missing: string;
  why: string;
  owner: 'bruno' | 'engineering' | 'provider';
}

/** Compute what is still missing before connectors can be verified. */
export function inventoryBlockers(inv: Inventory): Blocker[] {
  const b: Blocker[] = [];
  const need = (cond: boolean, area: string, missing: string, why: string, owner: Blocker['owner'] = 'bruno') => {
    if (cond) b.push({ area, missing, why, owner });
  };
  need(inv.phone.osVersion === null, 'phone', 'iOS version (Settings → General → About)', 'Framework availability (App Intents, CallKit, TelephonyMessagingKit) depends on it');
  need(inv.phone.appStoreRegion === null, 'phone', 'App Store region / Apple ID country', 'Determines TestFlight distribution and any region-gated entitlements');
  need(inv.phone.numbers.length === 0, 'phone', 'Phone number(s) to protect and the number callers use', 'Needed to plan conditional call forwarding and rollback');
  need(inv.email.length === 0, 'email', 'Email accounts and providers, per space', 'Gmail/Outlook connectors are the Week 3 critical path');
  need(inv.calendars.length === 0, 'calendar', 'Calendar provider(s)', 'Scheduling workflows need the primary calendar');
  need(inv.messaging.length === 0, 'messaging', 'Messaging services in use (WhatsApp personal/business, Telegram, ...)', 'Week 9 picks the highest-priority verified connector');
  need(inv.social.length === 0, 'social', 'Social accounts and whether each is personal, business or creator', 'DM access depends on account type and approved permissions');
  need(inv.existingAssistantCode.length === 0, 'code', 'Existing browser-assistant repository', 'Spec requires inspecting it before reuse');
  if (inv.phone.os === 'iOS')
    b.push({
      area: 'phone',
      missing: 'Apple Developer Program membership (individual or organization)',
      why: 'Required for TestFlight, push notifications, CallKit/PushKit and App Intents on a real device',
      owner: 'bruno',
    });
  return b;
}
