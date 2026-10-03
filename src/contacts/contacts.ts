import { type Space, JenniferError } from '../core/types.js';
import { newId } from '../core/util.js';

export type IdentityKind = 'email' | 'phone' | 'whatsapp' | 'handle';

export interface ContactIdentity {
  kind: IdentityKind;
  value: string; // normalized: lowercase email, E.164 phone
  verified: boolean;
  source: string;
}

export interface Contact {
  id: string;
  ownerId: string;
  displayName: string;
  spaces: Space[];
  identities: ContactIdentity[];
  /** Contact-specific instructions, e.g. tone for personal relationships (spec §1). */
  instructions?: string;
  relationship?: 'personal' | 'business' | 'service_provider' | 'unknown';
}

export function normalizeIdentity(kind: IdentityKind, value: string): string {
  const v = value.trim();
  if (kind === 'email') return v.toLowerCase();
  if (kind === 'phone' || kind === 'whatsapp') return v.replace(/[^\d+]/g, '');
  return v.toLowerCase();
}

export type RecipientResolution =
  | { status: 'resolved'; contact: Contact; identity: ContactIdentity }
  | { status: 'ambiguous'; candidates: Contact[] }
  | { status: 'unverified'; contact: Contact; reason: string }
  | { status: 'unknown' };

export class ContactDirectory {
  private contacts = new Map<string, Contact>();
  private listeners: Array<(c: Contact) => void> = [];

  onChange(fn: (c: Contact) => void): void {
    this.listeners.push(fn);
  }

  add(input: Omit<Contact, 'id'>): Contact {
    const c: Contact = {
      ...input,
      id: newId('ct'),
      identities: input.identities.map((i) => ({ ...i, value: normalizeIdentity(i.kind, i.value) })),
    };
    this.contacts.set(c.id, c);
    this.listeners.forEach((l) => l(c));
    return c;
  }

  restore(contacts: Contact[]): void {
    for (const c of contacts) this.contacts.set(c.id, c);
  }

  get(id: string): Contact {
    const c = this.contacts.get(id);
    if (!c) throw new JenniferError('contact.not_found', `No contact ${id}`);
    return c;
  }

  list(ownerId: string): Contact[] {
    return [...this.contacts.values()].filter((c) => c.ownerId === ownerId);
  }

  /**
   * Bruno approved a message to this address: create the contact or mark the
   * identity verified (his approval is the verification). Adds the space.
   */
  learnFromApproval(ownerId: string, kind: IdentityKind, value: string, space: Space, displayName?: string): Contact {
    const v = normalizeIdentity(kind, value);
    const existing = this.findByIdentity(ownerId, kind, v);
    if (existing) {
      const ident = existing.identities.find((i) => i.kind === kind && i.value === v)!;
      ident.verified = true;
      ident.source = ident.source.includes('bruno-approved') ? ident.source : `${ident.source}+bruno-approved`;
      if (!existing.spaces.includes(space)) existing.spaces.push(space);
      this.listeners.forEach((l) => l(existing));
      return existing;
    }
    return this.add({ ownerId, displayName: displayName || v, spaces: [space], identities: [{ kind, value: v, verified: true, source: 'bruno-approved' }], relationship: 'unknown' });
  }

  findByIdentity(ownerId: string, kind: IdentityKind, value: string): Contact | undefined {
    const v = normalizeIdentity(kind, value);
    return this.list(ownerId).find((c) => c.identities.some((i) => i.kind === kind && i.value === v));
  }

  verifiedIdentity(contact: Contact, kind: IdentityKind): ContactIdentity | undefined {
    return contact.identities.find((i) => i.kind === kind && i.verified);
  }

  /**
   * Resolve a recipient by name within a purpose (space). Shared names never
   * resolve implicitly (spec Scenario D): a verified identifier must disambiguate.
   */
  resolveByName(ownerId: string, name: string, space: Space, kind: IdentityKind, hint?: string): RecipientResolution {
    const n = name.trim().toLowerCase();
    let candidates = this.list(ownerId).filter((c) => c.displayName.toLowerCase() === n);
    if (candidates.length === 0) return { status: 'unknown' };
    if (candidates.length > 1) {
      const inSpace = candidates.filter((c) => c.spaces.includes(space));
      if (inSpace.length === 1) candidates = inSpace;
    }
    if (candidates.length > 1 && hint) {
      const h = normalizeIdentity(kind, hint);
      const byHint = candidates.filter((c) => c.identities.some((i) => i.kind === kind && i.verified && i.value === h));
      if (byHint.length === 1) candidates = byHint;
    }
    if (candidates.length > 1) return { status: 'ambiguous', candidates };
    const contact = candidates[0]!;
    const identity = this.verifiedIdentity(contact, kind);
    if (!identity) return { status: 'unverified', contact, reason: `no verified ${kind} identity` };
    return { status: 'resolved', contact, identity };
  }

  /** Merge only when both contacts share at least one verified identifier (spec §2). */
  merge(keepId: string, dropId: string): Contact {
    const keep = this.get(keepId);
    const drop = this.get(dropId);
    const shared = keep.identities.some((a) => a.verified && drop.identities.some((b) => b.verified && a.kind === b.kind && a.value === b.value));
    if (!shared) throw new JenniferError('contact.merge_unverified', 'Contacts can only be merged on a matching verified identifier; similar names are insufficient');
    for (const i of drop.identities) if (!keep.identities.some((k) => k.kind === i.kind && k.value === i.value)) keep.identities.push(i);
    keep.spaces = [...new Set([...keep.spaces, ...drop.spaces])];
    this.contacts.delete(dropId);
    this.listeners.forEach((l) => l(keep));
    return keep;
  }
}

export interface SenderAssessment {
  contact?: Contact;
  verified: boolean;
  warnings: string[];
}

/**
 * Detect spoofed display names and lookalike addresses (spec §6).
 * A matching display name with an unknown address is a warning, not an identity.
 */
export function assessSender(dir: ContactDirectory, ownerId: string, displayName: string, address: string): SenderAssessment {
  const addr = normalizeIdentity('email', address);
  const warnings: string[] = [];
  const exact = dir.findByIdentity(ownerId, 'email', addr);
  if (exact) {
    const id = exact.identities.find((i) => i.kind === 'email' && i.value === addr)!;
    return { contact: exact, verified: id.verified, warnings: id.verified ? [] : ['sender address is known but not verified'] };
  }
  const contacts = dir.list(ownerId);
  const nameMatch = contacts.find((c) => c.displayName.toLowerCase() === displayName.trim().toLowerCase());
  if (nameMatch) warnings.push(`display name matches ${nameMatch.displayName} but the address is not one of their known addresses`);

  const [local, domain] = addr.split('@');
  for (const c of contacts) {
    for (const i of c.identities) {
      if (i.kind !== 'email') continue;
      const [kl, kd] = i.value.split('@');
      if (!kd || !domain || !kl || !local) continue;
      if (kd !== domain && isLookalike(kd, domain)) warnings.push(`domain ${domain} resembles known domain ${kd}`);
      else if (kd === domain && kl !== local && isLookalike(kl, local) && kl.length > 3) warnings.push(`address ${addr} resembles known address ${i.value}`);
    }
  }
  return { verified: false, warnings: [...new Set(warnings)] };
}

const HOMOGLYPHS: Record<string, string> = { '0': 'o', '1': 'l', rn: 'm', vv: 'w', '3': 'e', '5': 's' };

function skeleton(s: string): string {
  let out = s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  for (const [k, v] of Object.entries(HOMOGLYPHS)) out = out.split(k).join(v);
  return out.replace(/i/g, 'l');
}

export function isLookalike(known: string, candidate: string): boolean {
  if (known === candidate) return false;
  if (skeleton(known) === skeleton(candidate)) return true;
  return levenshtein(known, candidate) <= (known.length > 8 ? 2 : 1);
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}
