import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { JenniferError } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import type { AuditLog } from '../audit/audit.js';
import { DEPARTMENTS, agentSettings, shiftSlot } from './departments.js';
import { ROLE_CATALOG } from './catalog.js';
import type { CompanyRepo } from './repo.js';
import type { Artifact, Company, CompanyId, Membership, Run, RunEvent, RunStatus, RunStep } from './model.js';
import { TERMINAL_RUN } from './model.js';
// (Run['error'] is filled from the summary so the safe message is stored once.)
import type { RoleExecutor } from './executor.js';
import type { CompanyBrain } from './brain.js';
import type { CompanyCrm } from './crm.js';

/**
 * Company OS run engine (blueprint §2, §6, §13, F05): a run is persisted
 * (queued) before any work, steps are persisted as they finish, and every
 * state change is an ordered event. A restart resumes unfinished runs from
 * their last completed step; finished steps are never repeated. Cancelling
 * stops future steps and never pretends to undo a completed external action.
 */

export const DEFAULT_COMPANIES: Company[] = [
  { id: 'insurance', name: 'Insurance agency (pilot)', timezone: 'Europe/Rome', locale: 'en', status: 'active', profile: {} },
  { id: 'technology', name: 'B&B Global Services', timezone: 'Europe/Rome', locale: 'en', status: 'active', profile: {} },
  { id: 'music', name: 'Music', timezone: 'Europe/Rome', locale: 'en', status: 'active', profile: {} },
  { id: 'restaurant', name: 'SavoryMind', timezone: 'Europe/Rome', locale: 'en', status: 'active', profile: {} },
  { id: 'nonprofit', name: 'United Youth Orchestra', timezone: 'Europe/Rome', locale: 'en', status: 'active', profile: {} },
  { id: 'learnnoelia', name: 'LearnNoelia', timezone: 'Europe/Rome', locale: 'en', status: 'active', profile: {} },
  { id: 'foundation', name: 'Esposito Dos Santos Foundation', timezone: 'Europe/Rome', locale: 'en', status: 'active', profile: {} },
  { id: 'dating', name: 'Dating app', timezone: 'Europe/Rome', locale: 'en', status: 'active', profile: {} },
];

/** Earlier default names, renamed in place once (an owner-chosen name is never overwritten). */
const RENAMED: Record<string, string> = { 'Technology ventures': 'B&B Global Services', 'Restaurant venture': 'SavoryMind' };

export interface StepContext {
  run: Run;
  company: Company;
  executor: RoleExecutor;
  brain: CompanyBrain;
  crm: CompanyCrm;
  repo: CompanyRepo;
  clock: Clock;
  /** Persist an artifact for this run (company-scoped). */
  artifact(kind: string, title: string, content: unknown, sources?: Artifact['sources']): Promise<Artifact>;
  emit(type: string, data: Record<string, unknown>): Promise<void>;
  remainingBudget(): number;
  spend(eur: number): void;
}

export type StepResult = { status: 'done' | 'skipped' } | { status: 'blocked'; blockers: string[] } | { status: 'failed'; error: string };

export interface WorkflowDef {
  id: string;
  version: number;
  name: string;
  description: string;
  roles: string[];
  input: z.ZodTypeAny;
  defaultBudgetEur: number;
  steps: Array<{ key: string; roleId?: string; label: string; run: (ctx: StepContext) => Promise<StepResult> }>;
}

export class CompanyOS {
  private workflows = new Map<string, WorkflowDef>();
  private seq = new Map<string, number>();
  private processing = new Set<string>();
  private listeners = new Map<string, Set<(e: RunEvent) => void>>();

  constructor(
    readonly d: {
      repo: CompanyRepo;
      clock: Clock;
      audit: AuditLog;
      executor: RoleExecutor;
      brain: CompanyBrain;
      crm: CompanyCrm;
      ownerId: string;
    },
  ) {}

  register(w: WorkflowDef): void {
    this.workflows.set(w.id, w);
  }

  workflowList() {
    return [...this.workflows.values()].map((w) => ({ id: w.id, version: w.version, name: w.name, description: w.description, roles: w.roles, steps: w.steps.map((s) => ({ key: s.key, label: s.label, roleId: s.roleId })), defaultBudgetEur: w.defaultBudgetEur, input: z.toJSONSchema(w.input) }));
  }

  /** Seed Bruno's five company spaces and his owner membership (idempotent). */
  private booted?: Promise<void>;
  bootstrap(): Promise<void> {
    return (this.booted ??= this.seed());
  }
  private async seed(): Promise<void> {
    const existing = await this.d.repo.companies();
    const have = new Set(existing.map((c) => c.id));
    for (const c of existing) if (RENAMED[c.name]) await this.d.repo.saveCompany({ ...c, name: RENAMED[c.name]! }, this.d.ownerId);
    for (const c of DEFAULT_COMPANIES) {
      if (!have.has(c.id)) await this.d.repo.saveCompany(c, this.d.ownerId);
      await this.d.repo.saveMembership({ companyId: c.id, userId: this.d.ownerId, role: 'owner', permissions: ['*'] });
    }
  }

  // ---- Access (blueprint §13: server-derived company scope) ----------------

  /** Companies this actor may see. */
  async companiesFor(actor: string): Promise<Company[]> {
    await this.bootstrap();
    const mine = new Set((await this.d.repo.memberships(actor)).filter((m) => !m.revokedAt).map((m) => m.companyId));
    return (await this.d.repo.companies()).filter((c) => mine.has(c.id));
  }

  /**
   * Verify membership (and permission) before anything touches company data.
   * Not a member → the same "not found" as a missing company, so the API
   * does not reveal which companies exist.
   */
  async access(actor: string, companyId: string, perm: 'read' | 'run' | 'review' | 'admin' = 'read'): Promise<{ company: Company; membership: Membership }> {
    await this.bootstrap();
    const m = (await this.d.repo.memberships(actor)).find((x) => x.companyId === companyId && !x.revokedAt);
    const company = (await this.d.repo.companies()).find((c) => c.id === companyId);
    if (!m || !company) throw new JenniferError('company.not_found', 'Not found');
    const allowed = m.role === 'owner' || m.permissions.includes('*') || m.permissions.includes(perm) || (perm === 'read' && m.role !== undefined);
    if (!allowed || (m.role === 'viewer' && perm !== 'read')) throw new JenniferError('company.forbidden', 'You do not have permission for this');
    return { company, membership: m };
  }

  async updateProfile(actor: string, companyId: CompanyId, profile: Record<string, unknown>): Promise<Company> {
    const { company } = await this.access(actor, companyId, 'admin');
    company.profile = { ...company.profile, ...profile };
    await this.d.repo.saveCompany(company, this.d.ownerId);
    this.d.audit.record(actor, 'company.profile_updated', companyId, { keys: Object.keys(profile) });
    return company;
  }

  async rename(actor: string, companyId: CompanyId, name: string): Promise<Company> {
    const { company } = await this.access(actor, companyId, 'admin');
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!clean) throw new JenniferError('company.bad_name', 'Give the company a name');
    company.name = clean;
    await this.d.repo.saveCompany(company, this.d.ownerId);
    this.d.audit.record(actor, 'company.renamed', companyId, { name: clean });
    return company;
  }

  async setStatus(actor: string, companyId: CompanyId, status: 'active' | 'paused'): Promise<Company> {
    const { company } = await this.access(actor, companyId, 'admin');
    company.status = status;
    await this.d.repo.saveCompany(company, this.d.ownerId);
    this.d.audit.record(actor, `company.${status}`, companyId, {});
    if (status === 'paused') for (const r of await this.d.repo.runs(companyId, 200)) if (!TERMINAL_RUN.has(r.status)) await this.cancel(actor, companyId, r.id);
    return company;
  }

  // ---- Runs ------------------------------------------------------------------

  async createRun(actor: string, companyId: CompanyId, workflowId: string, input: unknown, opts: { idempotencyKey?: string; budgetEur?: number; relatedRunId?: string } = {}): Promise<Run> {
    const { company } = await this.access(actor, companyId, 'run');
    if (company.status === 'paused') throw new JenniferError('company.paused', 'This company is paused');
    const wf = this.workflows.get(workflowId);
    if (!wf) throw new JenniferError('workflow.not_found', `Unknown workflow ${workflowId}`);
    if (opts.idempotencyKey) {
      const prior = await this.d.repo.runByKey(companyId, opts.idempotencyKey);
      if (prior) return prior; // same request again → same run, no second execution
    }
    const parsed = wf.input.safeParse(input ?? {});
    if (!parsed.success) throw new JenniferError('run.invalid_input', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const now = this.d.clock.now().toISOString();
    const run: Run = {
      id: newId('run'),
      companyId,
      workflowId,
      workflowVersion: wf.version,
      status: 'queued',
      input: parsed.data as Record<string, unknown>,
      initiatedBy: actor,
      idempotencyKey: opts.idempotencyKey,
      relatedRunId: opts.relatedRunId,
      steps: wf.steps.map((s) => ({ key: s.key, roleId: s.roleId, roleVersion: s.roleId ? 1 : undefined, status: 'pending' })),
      state: {},
      budgetEur: Math.min(opts.budgetEur ?? wf.defaultBudgetEur, 25),
      spentEur: 0,
      artifactIds: [],
      actionIds: [],
      blockers: [],
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.d.repo.saveRun(run);
    } catch (e) {
      if ((e as { code?: string }).code === 'run.duplicate_key' && opts.idempotencyKey) return (await this.d.repo.runByKey(companyId, opts.idempotencyKey))!;
      throw e;
    }
    this.seq.set(run.id, 0);
    await this.emit(run, 'run.queued', { workflowId, version: wf.version, initiatedBy: actor });
    this.d.audit.record(actor, 'company.run_created', run.id, { companyId, workflowId });
    void this.process(companyId, run.id);
    return run;
  }

  async getRun(actor: string, companyId: CompanyId, runId: string): Promise<Run> {
    await this.access(actor, companyId, 'read');
    const r = await this.d.repo.run(companyId, runId);
    if (!r) throw new JenniferError('run.not_found', 'Not found');
    return r;
  }

  async listRuns(actor: string, companyId: CompanyId, limit = 50) {
    await this.access(actor, companyId, 'read');
    return this.d.repo.runs(companyId, limit);
  }

  async events(actor: string, companyId: CompanyId, runId: string, afterSeq = 0) {
    await this.getRun(actor, companyId, runId);
    return this.d.repo.events(companyId, runId, afterSeq);
  }

  subscribe(companyId: CompanyId, runId: string, fn: (e: RunEvent) => void): () => void {
    const k = `${companyId}:${runId}`;
    const set = this.listeners.get(k) ?? new Set();
    set.add(fn);
    this.listeners.set(k, set);
    return () => set.delete(fn);
  }

  async cancel(actor: string, companyId: CompanyId, runId: string): Promise<Run> {
    await this.access(actor, companyId, 'run');
    const run = await this.d.repo.run(companyId, runId);
    if (!run) throw new JenniferError('run.not_found', 'Not found');
    if (TERMINAL_RUN.has(run.status)) return run;
    run.cancelRequested = true;
    if (!this.processing.has(run.id)) await this.finish(run, 'cancelled', 'Cancelled before the next step');
    else await this.d.repo.saveRun({ ...run, updatedAt: this.d.clock.now().toISOString() });
    await this.emit(run, 'run.cancel_requested', { by: actor, note: 'Future steps stop; completed external actions are not undone' });
    return (await this.d.repo.run(companyId, runId))!;
  }

  /** On boot: resume queued and running runs from their last completed step. */
  async resume(): Promise<number> {
    const open = await this.d.repo.runsWithStatus(['queued', 'running']);
    for (const r of open) void this.process(r.companyId, r.id);
    return open.length;
  }

  /** Wait for a run to settle (tests, synchronous API callers). */
  async settle(companyId: CompanyId, runId: string, timeoutMs = 30_000): Promise<Run> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.d.repo.run(companyId, runId);
      if (r && (TERMINAL_RUN.has(r.status) || r.status === 'waiting_approval') && !this.processing.has(runId)) return r;
      if (Date.now() > end) throw new Error(`run ${runId} did not settle`);
      await new Promise((res) => setTimeout(res, 10));
    }
  }

  private async process(companyId: CompanyId, runId: string): Promise<void> {
    if (this.processing.has(runId)) return;
    this.processing.add(runId);
    try {
      let run = (await this.d.repo.run(companyId, runId))!;
      const wf = this.workflows.get(run.workflowId);
      const company = (await this.d.repo.companies()).find((c) => c.id === companyId)!;
      if (!wf || wf.version !== run.workflowVersion) return void (await this.finish(run, 'failed', 'Workflow version is no longer available', { code: 'workflow.version_missing', retryable: false }));
      if (!this.seq.has(run.id)) this.seq.set(run.id, (await this.d.repo.events(companyId, runId, 0)).at(-1)?.seq ?? 0);
      if (run.status === 'queued') {
        run.status = 'running';
        await this.save(run);
        await this.emit(run, 'run.started', {});
      }
      for (const def of wf.steps) {
        run = (await this.d.repo.run(companyId, runId))!;
        const step = run.steps.find((s) => s.key === def.key)!;
        if (step.status !== 'pending' && step.status !== 'running') continue; // finished before a restart
        if (run.cancelRequested) return void (await this.finish(run, 'cancelled', 'Cancelled'));
        step.status = 'running';
        step.startedAt = this.d.clock.now().toISOString();
        await this.save(run);
        await this.emit(run, 'step.started', { step: def.key, label: def.label, roleId: def.roleId });
        let result: StepResult;
        try {
          result = await def.run(this.context(run, company));
        } catch (e) {
          result = { status: 'failed', error: (e as Error).message };
        }
        run = { ...(await this.d.repo.run(companyId, runId))!, state: run.state, spentEur: run.spentEur, artifactIds: run.artifactIds, actionIds: run.actionIds, steps: run.steps };
        step.status = result.status;
        step.finishedAt = this.d.clock.now().toISOString();
        await this.save(run);
        await this.emit(run, 'step.finished', { step: def.key, status: result.status, ...(result.status === 'blocked' ? { blockers: result.blockers } : {}), ...(result.status === 'failed' ? { error: result.error } : {}) });
        if (result.status === 'blocked') return void (await this.finish(run, 'blocked', result.blockers.join('; '), undefined, result.blockers));
        if (result.status === 'failed') return void (await this.finish(run, 'failed', result.error, { code: 'step.failed', retryable: true }));
      }
      await this.finish(run, 'succeeded', (run.state.summary as string) ?? 'Completed');
    } finally {
      this.processing.delete(runId);
    }
  }

  private context(run: Run, company: Company): StepContext {
    return {
      run,
      company,
      executor: this.d.executor,
      brain: this.d.brain,
      crm: this.d.crm,
      repo: this.d.repo,
      clock: this.d.clock,
      artifact: async (kind, title, content, sources = []) => {
        const a: Artifact = {
          id: newId('art'),
          companyId: run.companyId,
          runId: run.id,
          kind,
          title,
          content,
          contentHash: createHash('sha256').update(JSON.stringify(content)).digest('hex'),
          sources,
          review: 'pending',
          createdAt: this.d.clock.now().toISOString(),
        };
        await this.d.repo.saveArtifact(a);
        run.artifactIds.push(a.id);
        await this.emit(run, 'artifact.created', { artifactId: a.id, kind, title });
        return a;
      },
      emit: (type, data) => this.emit(run, type, data),
      remainingBudget: () => Math.max(0, run.budgetEur - run.spentEur),
      spend: (eur) => {
        run.spentEur = +(run.spentEur + eur).toFixed(6);
      },
    };
  }

  private async save(run: Run) {
    run.updatedAt = this.d.clock.now().toISOString();
    await this.d.repo.saveRun(run);
  }

  private async finish(run: Run, status: RunStatus, summary: string, error?: { code: string; retryable: boolean }, blockers: string[] = []) {
    run.status = status;
    run.summary = summary;
    run.error = error ? { ...error, message: summary } : undefined;
    run.blockers = blockers;
    await this.save(run);
    await this.emit(run, `run.${status}`, { summary, blockers, spentEur: run.spentEur });
  }

  private async emit(run: Run, type: string, data: Record<string, unknown>) {
    const seq = (this.seq.get(run.id) ?? 0) + 1;
    this.seq.set(run.id, seq);
    const e: RunEvent = { companyId: run.companyId, runId: run.id, seq, type, at: this.d.clock.now().toISOString(), data };
    await this.d.repo.appendEvent(e);
    for (const l of this.listeners.get(`${run.companyId}:${run.id}`) ?? []) l(e);
  }

  /**
   * Opt-in schedules (blueprint WF-03): a company whose profile has
   * briefTime "HH:MM" gets one brief per local day in its own time zone.
   * The idempotency key makes a retry or second worker produce no duplicate.
   */
  async tickSchedules(): Promise<string[]> {
    await this.bootstrap();
    const started: string[] = [];
    const now = this.d.clock.now();
    for (const c of await this.d.repo.companies()) {
      if (c.status === 'active' && c.profile.weeklyContent === true) {
        // Fridays from 09:00 local: plan next week's posts once.
        const local = DateTime.fromJSDate(now, { zone: c.timezone });
        if (local.weekday === 5 && local.toFormat('HH:mm') >= '09:00') {
          const weekOf = local.plus({ weeks: 1 }).startOf('week').toISODate()!;
          const key = `schedule:WF-04:${weekOf}`;
          if (!(await this.d.repo.runByKey(c.id, key))) started.push((await this.createRun(this.d.ownerId, c.id, 'WF-04', { weekOf }, { idempotencyKey: key })).id);
        }
      }
      // Department agents (WF-05): each on-duty department works one shift per slot, day and night.
      if (c.status === 'active' && this.workflows.has('WF-05')) {
        const a = agentSettings(c.profile);
        if (a.enabled && (await this.d.brain.approvedCategories(c.id)).size) {
          const slot = shiftSlot(now, a.everyHours);
          for (const dept of DEPARTMENTS) {
            if (a.off.includes(dept)) continue;
            const key = `schedule:WF-05:${dept}:${a.everyHours}h:${slot}`;
            if (!(await this.d.repo.runByKey(c.id, key))) started.push((await this.createRun(this.d.ownerId, c.id, 'WF-05', { department: dept }, { idempotencyKey: key })).id);
          }
        }
      }
      const t = c.profile.briefTime;
      if (c.status !== 'active' || typeof t !== 'string' || !/^\d{2}:\d{2}$/.test(t)) continue;
      const local = DateTime.fromJSDate(now, { zone: c.timezone });
      if (local.toFormat('HH:mm') < t) continue;
      const day = local.toISODate()!;
      const key = `schedule:WF-03:${day}`;
      if (await this.d.repo.runByKey(c.id, key)) continue;
      const run = await this.createRun(this.d.ownerId, c.id, 'WF-03', { date: day }, { idempotencyKey: key });
      started.push(run.id);
    }
    return started;
  }

  /** Organization map data: departments, roles and readiness. */
  static departments() {
    const out: Record<string, { total: number; pilot: number }> = {};
    for (const r of ROLE_CATALOG) {
      const d = (out[r.department] ??= { total: 0, pilot: 0 });
      d.total++;
      if (r.pilot) d.pilot++;
    }
    return out;
  }
}
