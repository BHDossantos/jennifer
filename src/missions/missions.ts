import { DateTime } from 'luxon';
import { z } from 'zod';
import { JenniferError, SPACES, type Space } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import type { Db } from '../db/db.js';
import type { AuthorityRegistry } from '../policy/authority.js';
import { assertZone } from '../calendar/calendar.js';

/**
 * Missions: Jennifer's always-on agents (similar in spirit to ChatGPT
 * "dots"). A mission has a goal, the sources it may read, a schedule, and
 * per-action autonomy. Scheduled background runs are read-only research;
 * "work" runs may propose actions, which still pass the authority registry
 * and the single executor. A mission can never approve its own actions.
 */

/** The four autonomy levels per action kind (mirrors dots' custom rules). */
export const AUTONOMY = ['act', 'act_if_preapproved', 'ask', 'hand_over'] as const;
export type Autonomy = (typeof AUTONOMY)[number];

/** Drafts are always allowed (they are never sent); these are the actions with autonomy levels. */
export const MISSION_ACTIONS = ['send_email', 'create_event'] as const;
export type MissionAction = (typeof MISSION_ACTIONS)[number];

export const MissionInputSchema = z.object({
  title: z.string().min(2).max(80),
  goal: z.string().min(5).max(2000),
  space: z.enum(SPACES).default('personal'),
  sources: z.array(z.enum(['email', 'memory', 'calendar', 'brief', 'ai_history', 'web'])).min(1).default(['email', 'memory']),
  schedule: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('manual') }),
      z.object({ kind: z.literal('interval'), minutes: z.number().int().min(15).max(24 * 60) }),
      z.object({ kind: z.literal('daily'), localTime: z.string().regex(/^\d{2}:\d{2}$/), weekdays: z.array(z.number().int().min(1).max(7)).optional() }),
    ])
    .default({ kind: 'manual' }),
  timeZone: z.string().default('Europe/Rome'),
  autonomy: z.partialRecord(z.enum(MISSION_ACTIONS), z.enum(AUTONOMY)).default({}),
  /** Contacts whose actions count as pre-approved for 'act_if_preapproved'. */
  preapprovedContactIds: z.array(z.string()).default([]),
  budget: z
    .object({
      maxCostEurPerRun: z.number().positive().max(5).default(0.25),
      maxToolCallsPerRun: z.number().int().positive().max(100).default(20),
      maxRunsPerDay: z.number().int().positive().max(96).default(24),
    })
    .default({ maxCostEurPerRun: 0.25, maxToolCallsPerRun: 20, maxRunsPerDay: 24 }),
});
export type MissionInput = z.input<typeof MissionInputSchema>;

export interface ActivityEntry {
  at: string;
  kind: 'created' | 'run_started' | 'tool' | 'proposal' | 'result' | 'run_finished' | 'error' | 'paused' | 'resumed' | 'autonomy_changed';
  text: string;
  ref?: string;
}

export interface MissionResult {
  id: string;
  at: string;
  title: string;
  body: string;
  sources: string[];
  proposedActionIds: string[];
  status: 'new' | 'reviewed' | 'dismissed';
}

export type Mission = z.output<typeof MissionInputSchema> & {
  id: string;
  ownerId: string;
  status: 'active' | 'paused' | 'archived';
  createdAt: string;
  lastRunAt?: string;
  runsToday: { date: string; count: number };
  authorityRuleIds: string[];
  notes: string; // mission working memory carried between runs
  activity: ActivityEntry[];
  results: MissionResult[];
};

const MAX_ACTIVITY = 300;

export interface MissionStore {
  list(ownerId: string): Promise<Mission[]>;
  get(id: string): Promise<Mission | undefined>;
  save(m: Mission): Promise<void>;
}

export class MemoryMissionStore implements MissionStore {
  private m = new Map<string, Mission>();
  async list(ownerId: string) {
    return [...this.m.values()].filter((x) => x.ownerId === ownerId).map((x) => structuredClone(x));
  }
  async get(id: string) {
    const x = this.m.get(id);
    return x ? structuredClone(x) : undefined;
  }
  async save(m: Mission) {
    this.m.set(m.id, structuredClone(m));
  }
}

export class PgMissionStore implements MissionStore {
  constructor(private db: Db) {}
  async list(ownerId: string) {
    return (await this.db.query<{ data: Mission }>('SELECT data FROM mission WHERE owner_id = $1 ORDER BY created_at', [ownerId])).rows.map((r) => r.data);
  }
  async get(id: string) {
    return (await this.db.query<{ data: Mission }>('SELECT data FROM mission WHERE id = $1', [id])).rows[0]?.data;
  }
  async save(m: Mission) {
    await this.db.query(
      `INSERT INTO mission (id, owner_id, status, data, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, updated_at = now()`,
      [m.id, m.ownerId, m.status, JSON.stringify(m), m.createdAt],
    );
  }
}

export function log(m: Mission, clock: Clock, kind: ActivityEntry['kind'], text: string, ref?: string): void {
  m.activity.push({ at: clock.now().toISOString(), kind, text, ref });
  if (m.activity.length > MAX_ACTIVITY) m.activity.splice(0, m.activity.length - MAX_ACTIVITY);
}

/**
 * Translate mission autonomy into ordinary authority rules scoped to this
 * mission (workflowIds), so the executor enforces them like any other rule.
 * Money, signatures and security changes are never covered.
 */
export function grantMissionAuthority(registry: AuthorityRegistry, m: Mission, principal: string): string[] {
  const ids: string[] = [];
  const scopeBase = { workflowIds: [m.id], spaces: [m.space] as Space[] };
  const add = (action: 'send_message' | 'create_event', level: Autonomy) => {
    if (level === 'act') ids.push(registry.grant({ principal, action, mode: 'execute', scope: scopeBase, limits: { maxRecipients: 3 }, note: `mission:${m.id}` }).id);
    else if (level === 'act_if_preapproved') {
      if (m.preapprovedContactIds.length)
        ids.push(registry.grant({ principal, action, mode: 'execute', scope: { ...scopeBase, contactIds: m.preapprovedContactIds }, limits: { maxRecipients: 3 }, note: `mission:${m.id}:preapproved` }).id);
      ids.push(registry.grant({ principal, action, mode: 'ask', scope: scopeBase, note: `mission:${m.id}` }).id);
    } else if (level === 'ask') ids.push(registry.grant({ principal, action, mode: 'ask', scope: scopeBase, note: `mission:${m.id}` }).id);
    else ids.push(registry.grant({ principal, action, mode: 'draft', scope: scopeBase, note: `mission:${m.id}:hand_over` }).id);
  };
  add('send_message', m.autonomy.send_email ?? 'ask');
  add('create_event', m.autonomy.create_event ?? 'ask');
  return ids;
}

export function revokeMissionAuthority(registry: AuthorityRegistry, m: Mission, principal: string): void {
  for (const id of m.authorityRuleIds) {
    try {
      if (registry.isActive(registry.get(id))) registry.revoke(id, principal);
    } catch {
      /* already gone */
    }
  }
  m.authorityRuleIds = [];
}

export function newMission(ownerId: string, input: MissionInput, clock: Clock): Mission {
  const parsed = MissionInputSchema.parse(input);
  assertZone(parsed.timeZone);
  const now = clock.now();
  return {
    ...parsed,
    id: newId('msn'),
    ownerId,
    status: 'active',
    createdAt: now.toISOString(),
    runsToday: { date: now.toISOString().slice(0, 10), count: 0 },
    authorityRuleIds: [],
    notes: '',
    activity: [],
    results: [],
  };
}

/** Is a scheduled (research) run due? DST-safe for daily schedules. */
export function isDue(m: Mission, now: Date): boolean {
  if (m.status !== 'active' || m.schedule.kind === 'manual') return false;
  const last = m.lastRunAt ? new Date(m.lastRunAt) : undefined;
  if (m.schedule.kind === 'interval') return !last || now.getTime() - last.getTime() >= m.schedule.minutes * 60_000;
  const [hh, mm] = m.schedule.localTime.split(':').map(Number);
  const local = DateTime.fromJSDate(now, { zone: m.timeZone });
  const slot = local.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  if (m.schedule.weekdays && !m.schedule.weekdays.includes(slot.weekday)) return false;
  if (local < slot) return false;
  return !last || last < slot.toJSDate();
}

export function assertActive(m: Mission | undefined): Mission {
  if (!m) throw new JenniferError('mission.not_found', 'No such mission');
  return m;
}

/** Ready-made missions Bruno can start from. */
export const MISSION_PRESETS: Array<{ id: string } & MissionInput> = [
  {
    id: 'inbox_watch',
    title: 'Inbox watch',
    goal: 'Every 30 minutes, review new email. Tell me what is important or time-sensitive, ignore newsletters and promotions, and draft replies for messages that need one.',
    sources: ['email', 'memory'],
    schedule: { kind: 'interval', minutes: 30 },
    autonomy: { send_email: 'ask' },
  },
  {
    id: 'morning_priorities',
    title: 'Morning priorities',
    goal: 'Each weekday morning, prepare my priorities: decisions waiting for me, urgent email, deadlines this week, and anything that failed or needs reconnecting.',
    sources: ['brief', 'email', 'memory', 'calendar'],
    schedule: { kind: 'daily', localTime: '07:30', weekdays: [1, 2, 3, 4, 5] },
    autonomy: { send_email: 'hand_over' },
  },
  {
    id: 'follow_up_tracker',
    title: 'Follow-up tracker',
    goal: 'Find conversations where I am waiting on someone for more than 3 days, and draft a short, polite follow-up for my review. Never follow up with anyone I asked you to stop contacting.',
    sources: ['email', 'memory'],
    schedule: { kind: 'daily', localTime: '10:00', weekdays: [1, 2, 3, 4, 5] },
    autonomy: { send_email: 'ask' },
  },
];
