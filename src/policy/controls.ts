import { type Clock, newId } from '../core/util.js';
import type { AuditLog } from '../audit/audit.js';
import type { Channel } from '../core/types.js';

/**
 * Global pause, per-connector pause, per-contact pause and emergency stop
 * (spec §14). Stopping cancels queued work; it cannot unsend sent messages.
 */
export interface ControlsSnapshot {
  emergency: boolean;
  globalPaused: boolean;
  pausedConnectors: string[];
  pausedContacts: string[];
}

export class Controls {
  private globalPaused = false;
  private emergency = false;
  private pausedConnectors = new Set<string>();
  private pausedContacts = new Set<string>();
  private listeners: Array<(kind: 'emergency' | 'global' | 'connector' | 'contact', id?: string) => void> = [];
  private changeListeners: Array<() => void> = [];

  constructor(private audit: AuditLog) {}

  /** Any change (pause or resume) — used to persist the switches. */
  onChange(fn: () => void): void {
    this.changeListeners.push(fn);
  }

  snapshot(): ControlsSnapshot {
    return { emergency: this.emergency, globalPaused: this.globalPaused, pausedConnectors: [...this.pausedConnectors], pausedContacts: [...this.pausedContacts] };
  }

  /** A restart never silently lifts a pause or an emergency stop. */
  restore(s: ControlsSnapshot): void {
    this.emergency = s.emergency;
    this.globalPaused = s.globalPaused;
    this.pausedConnectors = new Set(s.pausedConnectors);
    this.pausedContacts = new Set(s.pausedContacts);
  }

  private changed(): void {
    this.changeListeners.forEach((l) => l());
  }

  onStop(fn: (kind: 'emergency' | 'global' | 'connector' | 'contact', id?: string) => void): void {
    this.listeners.push(fn);
  }

  emergencyStop(actor: string): void {
    this.emergency = true;
    this.globalPaused = true;
    this.audit.record(actor, 'controls.emergency_stop', undefined, {});
    this.changed();
    this.listeners.forEach((l) => l('emergency'));
  }

  pauseAll(actor: string): void {
    this.globalPaused = true;
    this.audit.record(actor, 'controls.global_pause', undefined, {});
    this.changed();
    this.listeners.forEach((l) => l('global'));
  }

  resumeAll(actor: string): void {
    this.globalPaused = false;
    this.emergency = false;
    this.audit.record(actor, 'controls.global_resume', undefined, {});
    this.changed();
  }

  pauseConnector(actor: string, connectorId: string): void {
    this.pausedConnectors.add(connectorId);
    this.audit.record(actor, 'controls.connector_pause', connectorId, {});
    this.changed();
    this.listeners.forEach((l) => l('connector', connectorId));
  }

  resumeConnector(actor: string, connectorId: string): void {
    this.pausedConnectors.delete(connectorId);
    this.audit.record(actor, 'controls.connector_resume', connectorId, {});
    this.changed();
  }

  pauseContact(actor: string, contactId: string): void {
    this.pausedContacts.add(contactId);
    this.audit.record(actor, 'controls.contact_pause', contactId, {});
    this.changed();
    this.listeners.forEach((l) => l('contact', contactId));
  }

  resumeContact(actor: string, contactId: string): void {
    this.pausedContacts.delete(contactId);
    this.audit.record(actor, 'controls.contact_resume', contactId, {});
    this.changed();
  }

  /** Returns a blocking reason or undefined when execution may proceed. */
  blockReason(connectorId: string, contactIds: string[]): string | undefined {
    if (this.emergency) return 'emergency stop is active';
    if (this.globalPaused) return 'Jennifer is paused';
    if (this.pausedConnectors.has(connectorId)) return `connector ${connectorId} is paused`;
    const c = contactIds.find((id) => this.pausedContacts.has(id));
    if (c) return `contact ${c} is paused`;
    return undefined;
  }

  status() {
    return {
      emergencyStop: this.emergency,
      globalPaused: this.globalPaused,
      pausedConnectors: [...this.pausedConnectors],
      pausedContacts: [...this.pausedContacts],
      note: 'Stopping cancels queued work. Messages already accepted by a provider cannot reliably be unsent.',
    };
  }
}

export interface SuppressionRule {
  id: string;
  contactId?: string;
  address?: string; // email address or phone number
  domain?: string;
  channels: Channel[] | 'all';
  reason: string;
  createdBy: string;
  createdAt: Date;
  liftedAt?: Date;
}

export interface SuppressionTarget {
  contactIds: string[];
  addresses: string[];
  channel: Channel;
}

/**
 * "Stop contacting X" creates a persistent suppression across all workflows
 * until Bruno lifts it (spec §16). Enforced in the executor and in triggers.
 */
export class SuppressionList {
  private rules: SuppressionRule[] = [];
  private listeners: Array<(rule: SuppressionRule) => void> = [];

  constructor(
    private clock: Clock,
    private audit: AuditLog,
  ) {}

  private changeListeners: Array<() => void> = [];

  onAdd(fn: (rule: SuppressionRule) => void): void {
    this.listeners.push(fn);
  }

  onChange(fn: () => void): void {
    this.changeListeners.push(fn);
  }

  all(): SuppressionRule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  restore(rules: SuppressionRule[]): void {
    this.rules = rules.map((r) => ({ ...r, createdAt: new Date(r.createdAt), liftedAt: r.liftedAt ? new Date(r.liftedAt) : undefined }));
  }

  add(input: Omit<SuppressionRule, 'id' | 'createdAt' | 'liftedAt'>): SuppressionRule {
    const rule: SuppressionRule = {
      ...input,
      address: input.address?.toLowerCase(),
      domain: input.domain?.toLowerCase(),
      id: newId('sup'),
      createdAt: this.clock.now(),
    };
    this.rules.push(rule);
    this.audit.record(input.createdBy, 'suppression.added', rule.id, { contactId: rule.contactId, domain: rule.domain, reason: rule.reason });
    this.listeners.forEach((l) => l(rule));
    this.changeListeners.forEach((l) => l());
    return rule;
  }

  lift(id: string, actor: string): void {
    const r = this.rules.find((x) => x.id === id);
    if (r && !r.liftedAt) {
      r.liftedAt = this.clock.now();
      this.audit.record(actor, 'suppression.lifted', id, {});
      this.changeListeners.forEach((l) => l());
    }
  }

  active(): SuppressionRule[] {
    return this.rules.filter((r) => !r.liftedAt);
  }

  match(t: SuppressionTarget): SuppressionRule | undefined {
    const addrs = t.addresses.map((a) => a.toLowerCase());
    const domains = addrs.map((a) => a.split('@')[1]).filter((d): d is string => !!d);
    return this.active().find((r) => {
      if (r.channels !== 'all' && !r.channels.includes(t.channel)) return false;
      if (r.contactId && t.contactIds.includes(r.contactId)) return true;
      if (r.address && addrs.includes(r.address)) return true;
      if (r.domain && domains.includes(r.domain)) return true;
      return false;
    });
  }
}
