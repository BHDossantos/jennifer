import { DateTime } from 'luxon';
import type { ActionType, Space } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import type { CapabilityRegistry } from '../connectors/capabilities.js';
import type { ActionService } from '../actions/service.js';
import type { SuppressionList } from '../policy/controls.js';
import type { DeadLetterQueue } from '../events/events.js';
import type { MemoryStore } from '../memory/memory.js';
import { assertZone } from '../calendar/calendar.js';

/**
 * A proactive workflow is a stored instruction (spec §16). Execution runs in
 * durable server-side workers, never on a phone that may be asleep.
 */
export type WorkflowTrigger =
  | { kind: 'incoming_message'; connectorId: string; space?: Space }
  | { kind: 'calendar_change' }
  | { kind: 'scheduled'; localTime: string; weekdays?: number[] } // 1=Mon..7=Sun
  | { kind: 'follow_up_elapsed'; afterHours: number }
  | { kind: 'user_command' };

export interface ProactiveWorkflow {
  id: string;
  ownerId: string;
  name: string;
  template: WorkflowTemplate;
  trigger: WorkflowTrigger;
  timeZone: string;
  space: Space;
  inputs: Record<string, unknown>;
  allowedActions: ActionType[];
  exclusions: string[];
  cadence?: string;
  stopConditions: string[];
  successCriteria: string;
  maxFollowUpsPerRecipient: number;
  /** Only confirmed current instructions are activated (spec §16). */
  status: 'draft' | 'active' | 'paused';
  confirmedAt?: Date;
  lastRunAt?: Date;
}

export const WORKFLOW_TEMPLATES = [
  'email_triage',
  'appointment_scheduling',
  'document_preparation',
  'project_follow_up',
  'music_outreach_drafting',
  'job_opportunity_review',
  'travel_research',
  'daily_priorities',
] as const;
export type WorkflowTemplate = (typeof WORKFLOW_TEMPLATES)[number];

export class WorkflowRegistry {
  private workflows = new Map<string, ProactiveWorkflow>();
  private followUpCounts = new Map<string, number>(); // workflowId:recipient

  constructor(
    private clock: Clock,
    private suppressions: SuppressionList,
  ) {}

  create(input: Omit<ProactiveWorkflow, 'id' | 'status' | 'confirmedAt' | 'lastRunAt'>): ProactiveWorkflow {
    assertZone(input.timeZone);
    const wf: ProactiveWorkflow = { ...input, id: newId('wf'), status: 'draft' };
    this.workflows.set(wf.id, wf);
    return wf;
  }

  /** Bruno confirms a workflow's current instructions; only then does it run. */
  confirm(id: string): ProactiveWorkflow {
    const wf = this.get(id);
    wf.status = 'active';
    wf.confirmedAt = this.clock.now();
    return wf;
  }

  pause(id: string): void {
    this.get(id).status = 'paused';
  }

  get(id: string): ProactiveWorkflow {
    const wf = this.workflows.get(id);
    if (!wf) throw new Error(`No workflow ${id}`);
    return wf;
  }

  list(): ProactiveWorkflow[] {
    return [...this.workflows.values()];
  }

  /** Next occurrence of a scheduled trigger in the workflow's zone (DST-safe). */
  nextRun(wf: ProactiveWorkflow, after: Date = this.clock.now()): Date | undefined {
    if (wf.trigger.kind !== 'scheduled') return undefined;
    const [hh, mm] = wf.trigger.localTime.split(':').map(Number);
    let d = DateTime.fromJSDate(after, { zone: wf.timeZone }).set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
    if (d.toJSDate() <= after) d = d.plus({ days: 1 });
    for (let i = 0; i < 8; i++) {
      if (!wf.trigger.weekdays || wf.trigger.weekdays.includes(d.weekday)) return d.toJSDate();
      d = d.plus({ days: 1 });
    }
    return undefined;
  }

  due(now: Date = this.clock.now()): ProactiveWorkflow[] {
    return this.list().filter((wf) => {
      if (wf.status !== 'active' || wf.trigger.kind !== 'scheduled') return false;
      const next = this.nextRun(wf, wf.lastRunAt ?? new Date(now.getTime() - 24 * 3600_000));
      return !!next && next <= now;
    });
  }

  /** Recipient gating for proactive sends: suppression + follow-up caps. */
  mayContact(wf: ProactiveWorkflow, recipient: { contactIds: string[]; address: string }): { ok: boolean; reason?: string } {
    if (wf.status !== 'active') return { ok: false, reason: 'workflow is not active' };
    const sup = this.suppressions.match({ contactIds: recipient.contactIds, addresses: [recipient.address], channel: 'email' });
    if (sup) return { ok: false, reason: `suppressed: ${sup.reason}` };
    const k = `${wf.id}:${recipient.address.toLowerCase()}`;
    if ((this.followUpCounts.get(k) ?? 0) >= wf.maxFollowUpsPerRecipient) return { ok: false, reason: 'follow-up limit reached for this recipient' };
    return { ok: true };
  }

  recordFollowUp(wf: ProactiveWorkflow, address: string): void {
    const k = `${wf.id}:${address.toLowerCase()}`;
    this.followUpCounts.set(k, (this.followUpCounts.get(k) ?? 0) + 1);
  }
}

/** Detects a recipient's stop request in their reply. */
export function isStopRequest(text: string): boolean {
  return /\b(stop|unsubscribe|remove me|do not contact|don't contact|no more (emails|messages)|non contattarmi|pare de|no me contacte)\b/i.test(text);
}

export interface DailyBrief {
  generatedAt: string;
  timeZone: string;
  pendingDecisions: Array<{ id: string; summary: string }>;
  newUrgent: Array<{ id: string; summary: string }>;
  deadlines: Array<{ summary: string; due: string }>;
  completed: Array<{ id: string; summary: string }>;
  failures: Array<{ id: string; summary: string; recovery: string }>;
  connectorHealth: Array<{ connector: string; state: 'ok' | 'disconnected' | 'stale'; detail: string }>;
  /** Rest of today's calendar in the home time zone (empty when no calendar is connected). */
  today: Array<{ time: string; title: string; location?: string }>;
}

/**
 * The daily brief distinguishes "no new email" from "email account
 * disconnected" (spec §16, Scenario J): a disconnected connector is never
 * reported as a successful empty check.
 */
export function buildDailyBrief(deps: {
  clock: Clock;
  timeZone: string;
  capabilities: CapabilityRegistry;
  actions: ActionService;
  deadLetters: DeadLetterQueue;
  memory: MemoryStore;
  ownerId: string;
  urgentMessages: Array<{ id: string; summary: string }>;
  staleAfterHours?: number;
  calendarToday?: Array<{ startUtc: string; title: string; location?: string; busy?: boolean }>;
}): DailyBrief {
  const now = deps.clock.now();
  const staleMs = (deps.staleAfterHours ?? 6) * 3600_000;
  const monitored = deps.capabilities.list().filter((c) => c.capabilities.read.status !== 'unavailable' && (c.connected || c.accountId));
  const connectorHealth = monitored.map((c) => {
    if (!c.connected) return { connector: c.id, state: 'disconnected' as const, detail: `Disconnected: ${c.lastError ?? 'reconnect required'}. I could not check it.` };
    if (!c.lastSuccessfulSyncAt || now.getTime() - c.lastSuccessfulSyncAt.getTime() > staleMs)
      return { connector: c.id, state: 'stale' as const, detail: `Last successful sync ${c.lastSuccessfulSyncAt?.toISOString() ?? 'never'}; results may be incomplete.` };
    return { connector: c.id, state: 'ok' as const, detail: `Synced ${c.lastSuccessfulSyncAt.toISOString()}` };
  });
  const dayAgo = now.getTime() - 24 * 3600_000;
  return {
    generatedAt: now.toISOString(),
    timeZone: deps.timeZone,
    pendingDecisions: deps.actions.list({ state: 'awaiting_decision', ownerId: deps.ownerId }).map((a) => ({ id: a.id, summary: `${a.type}: ${a.decisionReasons.join('; ')}` })),
    newUrgent: deps.urgentMessages,
    deadlines: deps.memory
      .active(deps.ownerId)
      .filter((m) => m.kind === 'project_record' && m.effectiveUntil && m.effectiveUntil.getTime() > now.getTime() && m.effectiveUntil.getTime() - now.getTime() < 7 * 24 * 3600_000)
      .map((m) => ({ summary: m.value, due: m.effectiveUntil!.toISOString() })),
    completed: deps.actions
      .list({ ownerId: deps.ownerId })
      .filter((a) => (a.state === 'provider_accepted' || a.state === 'confirmed') && a.receipt && a.receipt.observedAt.getTime() > dayAgo)
      .map((a) => ({ id: a.id, summary: `${a.type} (${a.receipt!.evidence})` })),
    failures: deps.deadLetters.list().map((d) => ({ id: d.subjectId, summary: `${d.kind}: ${d.error}`, recovery: d.recoveryAction })),
    connectorHealth,
    today: (deps.calendarToday ?? []).map((e) => ({ time: DateTime.fromISO(e.startUtc, { zone: 'utc' }).setZone(deps.timeZone).toFormat('HH:mm'), title: e.title, location: e.location })),
  };
}
