import { z } from 'zod';
import { DateTime } from 'luxon';
import type { ActionService } from '../actions/service.js';
import type { ConversationStore } from '../events/conversations.js';
import type { SuppressionList } from '../policy/controls.js';
import type { CapabilityRegistry } from '../connectors/capabilities.js';
import type { CostLedger } from '../ops/costs.js';
import { detectClaims } from '../security/claims.js';
import type { Evidence } from './executor.js';
import type { StepContext, StepResult, WorkflowDef } from './engine.js';
import { canonicalDomain } from './crm.js';
import { roleVersion } from './roles.js';
import type { CompanyId } from './model.js';

export interface WorkflowDeps {
  actions: ActionService;
  conversations: ConversationStore;
  suppressions: SuppressionList;
  capabilities: CapabilityRegistry;
  costs: CostLedger;
  ownerId: string;
  web?: { search(q: string): Promise<{ answer: string; sources: Array<{ url: string; title?: string }> }>; read(url: string, maxChars?: number): Promise<{ url: string; title?: string; text: string }> };
}

const arr = (items: Record<string, unknown>) => ({ type: 'array', items: { type: 'object', additionalProperties: false, required: Object.keys(items), properties: items } });
const str = { type: 'string' };

/** Run one role step: budget, executor, accounting, blockers → StepResult. */
async function runRole<T>(ctx: StepContext, roleId: string, task: string, evidence: Evidence[], schema: Record<string, unknown>, parse: (x: unknown) => T): Promise<{ ok: true; data: T; out: Awaited<ReturnType<StepContext['executor']['execute']>> } | { ok: false; result: StepResult }> {
  const role = roleVersion(roleId)!;
  const companyContext = `${ctx.company.name} (company "${ctx.company.id}", timezone ${ctx.company.timezone}). Approved profile: ${JSON.stringify(ctx.company.profile).slice(0, 2000)}`;
  const out = await ctx.executor.execute({ role, companyId: ctx.company.id as CompanyId, companyContext, task, evidence, dataSchema: { schema, parse }, budget: { remainingEur: ctx.remainingBudget() } });
  ctx.spend(out.costEur);
  await ctx.emit('role.output', { roleId, status: out.status, summary: out.summary, blockers: out.blockers, costEur: out.costEur, sources: out.sources.map((s) => s.sourceId) });
  if (out.status === 'failed') return { ok: false, result: { status: 'failed', error: `${roleId}: ${out.summary} (${out.blockers.join('; ')})` } };
  if (out.status === 'blocked') return { ok: false, result: { status: 'blocked', blockers: out.blockers.length ? out.blockers : [out.summary] } };
  return { ok: true, data: out.data as T, out };
}

// ---- WF-03 Daily executive brief ----------------------------------------------

const BriefData = z.object({
  priorities: z.array(z.object({ title: z.string(), why: z.string(), ref: z.string() })).max(3),
  overdue: z.array(z.object({ title: z.string(), due: z.string(), ref: z.string() })),
  blockers: z.array(z.object({ title: z.string(), ref: z.string() })),
  decisions: z.array(z.object({ title: z.string(), ref: z.string() })),
  gaps: z.array(z.string()),
});

export function dailyBrief(d: WorkflowDeps): WorkflowDef {
  return {
    id: 'WF-03',
    version: 1,
    name: 'Daily executive brief',
    description: 'Three priorities, overdue commitments, blockers, decisions needed and yesterday’s measured completion and cost — every item linked to a record.',
    roles: ['O04', 'O12'],
    input: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    defaultBudgetEur: 0.5,
    steps: [
      {
        key: 'collect',
        label: 'Collecting tasks, decisions and blockers',
        run: async (ctx) => {
          const c = ctx.company.id as CompanyId;
          const now = ctx.clock.now();
          const localDay = (ctx.run.input.date as string) ?? DateTime.fromJSDate(now, { zone: ctx.company.timezone }).toISODate()!;
          const dayStart = DateTime.fromISO(localDay, { zone: ctx.company.timezone });
          const items: Evidence[] = [];
          for (const a of d.actions.list({ ownerId: d.ownerId, state: 'awaiting_decision' }).filter((a) => a.space === c))
            items.push({ sourceId: `action:${a.id}`, trusted: true, text: `DECISION NEEDED: ${a.type} — ${a.decisionReasons.join('; ')}` });
          for (const t of (await ctx.crm.records(c, 'task')).filter((t) => t.fields.status !== 'done' && t.fields.status !== 'cancelled'))
            items.push({ sourceId: `crm:${t.id}`, trusted: true, text: `TASK: ${t.fields.title} (owner ${t.fields.owner ?? 'unassigned'}, due ${t.fields.due ?? 'no date'}, status ${t.fields.status ?? 'open'})` });
          const runs = await ctx.repo.runs(c, 100);
          const since = dayStart.minus({ days: 1 });
          const recent = runs.filter((r) => r.id !== ctx.run.id && DateTime.fromISO(r.updatedAt) >= since);
          for (const r of recent.filter((r) => r.status === 'blocked' || r.status === 'failed')) items.push({ sourceId: `run:${r.id}`, trusted: true, text: `RUN ${r.status.toUpperCase()}: ${r.workflowId} — ${r.summary ?? ''}` });
          for (const p of await ctx.repo.patches(c, 'proposed')) items.push({ sourceId: `patch:${p.id}`, trusted: true, text: `CRM CHANGE TO REVIEW: ${p.reason}` });
          for (const s of (await ctx.repo.sources(c)).filter((s) => s.status === 'pending_review' || (s.reviewDueAt && Date.parse(s.reviewDueAt) < now.getTime())))
            items.push({ sourceId: `source:${s.id}`, trusted: true, text: `KNOWLEDGE TO REVIEW: ${s.title} (${s.status})` });
          const gaps: string[] = [];
          for (const cap of d.capabilities.list().filter((x) => x.accountId && !x.connected)) gaps.push(`${cap.id} is disconnected: its data could not be checked`);
          const yesterday = recent.filter((r) => DateTime.fromISO(r.updatedAt) < dayStart);
          ctx.run.state.evidence = items;
          ctx.run.state.measured = {
            day: localDay,
            completedRuns: yesterday.filter((r) => r.status === 'succeeded').length,
            failedRuns: yesterday.filter((r) => r.status === 'failed' || r.status === 'blocked').length,
            spentEur: +yesterday.reduce((s, r) => s + r.spentEur, 0).toFixed(4),
          };
          ctx.run.state.gaps = gaps;
          return { status: 'done' };
        },
      },
      {
        key: 'brief',
        roleId: 'O12',
        label: 'Writing the brief',
        run: async (ctx) => {
          const evidence = (ctx.run.state.evidence as Evidence[]) ?? [];
          const gaps = (ctx.run.state.gaps as string[]) ?? [];
          let brief: z.infer<typeof BriefData>;
          let sources: Array<{ sourceId: string }> = [];
          if (!ctx.executor.available || evidence.length === 0) {
            // Deterministic brief: nothing to synthesize, or no model configured.
            brief = {
              priorities: evidence.slice(0, 3).map((e) => ({ title: e.text.slice(0, 140), why: 'Open item', ref: e.sourceId })),
              overdue: [],
              blockers: evidence.filter((e) => e.sourceId.startsWith('run:')).map((e) => ({ title: e.text.slice(0, 140), ref: e.sourceId })),
              decisions: evidence.filter((e) => e.sourceId.startsWith('action:') || e.sourceId.startsWith('patch:')).map((e) => ({ title: e.text.slice(0, 140), ref: e.sourceId })),
              gaps: evidence.length ? gaps : [...gaps, 'No open tasks, decisions or blocked work were found for this company'],
            };
          } else {
            const r = await runRole(
              ctx,
              'O12',
              `Daily executive brief for ${ctx.run.state.measured && (ctx.run.state.measured as { day: string }).day}. Every item must reference a sourceId from the evidence. Known gaps: ${gaps.join('; ') || 'none'}.`,
              evidence,
              {
                type: 'object',
                additionalProperties: false,
                required: ['priorities', 'overdue', 'blockers', 'decisions', 'gaps'],
                properties: { priorities: arr({ title: str, why: str, ref: str }), overdue: arr({ title: str, due: str, ref: str }), blockers: arr({ title: str, ref: str }), decisions: arr({ title: str, ref: str }), gaps: { type: 'array', items: str } },
              },
              (x) => BriefData.parse(x),
            );
            if (!r.ok) return r.result;
            const refs = new Set(evidence.map((e) => e.sourceId));
            // Every material statement must link to a record: drop unreferenced items.
            brief = { ...r.data, priorities: r.data.priorities.filter((p) => refs.has(p.ref)), overdue: r.data.overdue.filter((p) => refs.has(p.ref)), blockers: r.data.blockers.filter((p) => refs.has(p.ref)), decisions: r.data.decisions.filter((p) => refs.has(p.ref)), gaps: [...new Set([...gaps, ...r.data.gaps])] };
            sources = r.out.sources;
          }
          await ctx.artifact('executive_brief', `Daily brief — ${ctx.company.name}`, { ...brief, measured: ctx.run.state.measured }, sources);
          ctx.run.state.summary = `${brief.priorities.length} priorities, ${brief.decisions.length} decisions, ${brief.blockers.length} blockers`;
          return { status: 'done' };
        },
      },
    ],
  };
}

// ---- WF-02 Incoming reply to next action ---------------------------------------

export const INTENTS = ['interested', 'question', 'meeting_request', 'not_now', 'not_interested', 'opt_out', 'complaint', 'wrong_contact', 'automatic_reply', 'uncertain'] as const;
const TriageData = z.object({
  intent: z.enum(INTENTS),
  source_message_id: z.string(),
  dates: z.array(z.string()),
  questions: z.array(z.string()),
  requested_actions: z.array(z.string()),
  opt_out: z.boolean(),
  complaint: z.boolean(),
  sensitive: z.boolean(),
  not_before: z.string(),
});
const CrmData = z.object({ changes: z.array(z.object({ field: z.string(), value: z.string(), source: z.string() })) });
const BriefSchema = z.object({ brief: z.string(), decisions_needed: z.array(z.string()), open_questions: z.array(z.string()) });

export function replyToNextAction(d: WorkflowDeps): WorkflowDef {
  return {
    id: 'WF-02',
    version: 1,
    name: 'Incoming reply to next action',
    description: 'Classify a reply, stop sequences and honor opt-outs immediately, propose CRM changes with evidence, and prepare a meeting brief when asked. Nothing is sent.',
    roles: ['D02', 'S12', 'D09', 'D05'],
    input: z.object({ conversationId: z.string().min(3) }),
    defaultBudgetEur: 0.6,
    steps: [
      {
        key: 'load',
        label: 'Reading the thread',
        run: async (ctx) => {
          const c = ctx.company.id;
          let conv;
          try {
            conv = d.conversations.getConversation(ctx.run.input.conversationId as string);
          } catch {
            return { status: 'blocked', blockers: ['Conversation not found'] };
          }
          // Company scope comes from the stored conversation, never from the request body.
          if (conv.space !== c || conv.ownerId !== d.ownerId) return { status: 'blocked', blockers: ['Conversation not found'] };
          const msgs = d.conversations.messagesIn(conv.id).slice(-6);
          const last = [...msgs].reverse().find((m) => m.direction === 'inbound');
          if (!last) return { status: 'blocked', blockers: ['No incoming message to triage'] };
          ctx.run.state.thread = msgs.map((m) => ({ sourceId: `message:${m.id}`, title: `${m.direction} from ${m.from.address} ${m.occurredAt.toISOString?.() ?? m.occurredAt}`, text: `Subject: ${m.subject ?? ''}\n${m.body}`, trusted: false }));
          ctx.run.state.lastMessageId = last.id;
          ctx.run.state.from = last.from.address.toLowerCase();
          ctx.run.state.fromName = last.from.displayName;
          return { status: 'done' };
        },
      },
      {
        key: 'triage',
        roleId: 'D02',
        label: 'Classifying the reply',
        run: async (ctx) => {
          const r = await runRole(
            ctx,
            'D02',
            `Classify the latest incoming message (message:${ctx.run.state.lastMessageId}). Allowed intents: ${INTENTS.join(', ')}. If they give a "not before" date, put it in not_before (YYYY-MM-DD) else "".`,
            ctx.run.state.thread as Evidence[],
            {
              type: 'object',
              additionalProperties: false,
              required: ['intent', 'source_message_id', 'dates', 'questions', 'requested_actions', 'opt_out', 'complaint', 'sensitive', 'not_before'],
              properties: {
                intent: { type: 'string', enum: [...INTENTS] },
                source_message_id: str,
                dates: { type: 'array', items: str },
                questions: { type: 'array', items: str },
                requested_actions: { type: 'array', items: str },
                opt_out: { type: 'boolean' },
                complaint: { type: 'boolean' },
                sensitive: { type: 'boolean' },
                not_before: str,
              },
            },
            (x) => TriageData.parse(x),
          );
          if (!r.ok) return r.result;
          ctx.run.state.triage = r.data;
          await ctx.artifact('reply_triage', `Reply from ${ctx.run.state.from}: ${r.data.intent}`, r.data, r.out.sources);
          return { status: 'done' };
        },
      },
      {
        key: 'route',
        label: 'Stopping sequences and honoring opt-outs',
        run: async (ctx) => {
          const t = ctx.run.state.triage as z.infer<typeof TriageData>;
          const from = ctx.run.state.from as string;
          const c = ctx.company.id as CompanyId;
          // Deterministic: any human reply pauses follow-ups to this contact; an opt-out suppresses and cancels.
          const human = t.intent !== 'automatic_reply';
          let paused = 0;
          if (human)
            for (const task of await ctx.crm.records(c, 'task')) {
              if (task.fields.contact === from && task.fields.kind === 'follow_up' && task.fields.status === 'open') {
                await ctx.repo.saveRecord({ ...task, version: task.version + 1, fields: { ...task.fields, status: 'paused', paused_reason: `reply received (${t.intent})` }, updatedAt: ctx.clock.now().toISOString() });
                paused++;
              }
            }
          let canceled: string[] = [];
          if (t.opt_out || t.intent === 'opt_out') {
            d.suppressions.add({ address: from, channels: 'all', reason: `opt-out in ${ctx.company.name} reply (message:${ctx.run.state.lastMessageId})`, createdBy: 'system' });
            canceled = d.actions
              .list({ ownerId: d.ownerId })
              .filter((a) => a.type === 'send_message' && (a.payload as { to?: string[] }).to?.some((x) => x.toLowerCase() === from))
              .filter((a) => d.actions.cancel(a.id, 'system', 'recipient opted out'))
              .map((a) => a.id);
          }
          await ctx.emit('routing.applied', { pausedFollowUps: paused, suppressed: !!(t.opt_out || t.intent === 'opt_out'), canceledActions: canceled });
          ctx.run.state.routing = { paused, canceled };
          return { status: 'done' };
        },
      },
      {
        key: 'crm',
        roleId: 'D09',
        label: 'Proposing CRM updates',
        run: async (ctx) => {
          const t = ctx.run.state.triage as z.infer<typeof TriageData>;
          if (t.intent === 'automatic_reply') return { status: 'skipped' };
          const c = ctx.company.id as CompanyId;
          const from = ctx.run.state.from as string;
          const dup = await ctx.crm.findDuplicate(c, 'contact', { email: from, name: ctx.run.state.fromName as string | undefined });
          const existing = dup.record;
          const changes: Record<string, { from?: unknown; to: unknown; source?: string }> = {};
          const src = `message:${ctx.run.state.lastMessageId}`;
          if (!existing) {
            changes.email = { to: from, source: src };
            if (ctx.run.state.fromName) changes.name = { to: ctx.run.state.fromName, source: src };
          }
          changes.last_intent = { from: existing?.fields.last_intent, to: t.intent, source: src };
          if (t.not_before) changes.not_before = { from: existing?.fields.not_before, to: t.not_before, source: src };
          if (t.opt_out || t.intent === 'opt_out') changes.status = { from: existing?.fields.status, to: 'do_not_contact', source: src };
          const patch = await ctx.crm.propose(c, { recordId: existing?.id, kind: 'contact', baseVersion: existing?.version, changes, runId: ctx.run.id, reason: `Reply from ${from}: ${t.intent}` });
          await ctx.emit('crm.patch_proposed', { patchId: patch.id });
          return { status: 'done' };
        },
      },
      {
        key: 'meeting_brief',
        roleId: 'D05',
        label: 'Preparing a meeting brief',
        run: async (ctx) => {
          const t = ctx.run.state.triage as z.infer<typeof TriageData>;
          if (t.intent !== 'meeting_request') return { status: 'skipped' };
          const c = ctx.company.id as CompanyId;
          const kb = await ctx.brain.search(c, `${ctx.run.state.fromName ?? ''} ${(t.questions ?? []).join(' ')}`, { categories: ['offer', 'brand', 'procedures'], limit: 4 });
          const evidence: Evidence[] = [...(ctx.run.state.thread as Evidence[]), ...kb.map((k) => ({ sourceId: k.sourceId, locator: k.locator, title: k.title, text: k.text, trusted: true }))];
          const r = await runRole(ctx, 'D05', `Meeting brief for the meeting requested by ${ctx.run.state.from}.`, evidence, { type: 'object', additionalProperties: false, required: ['brief', 'decisions_needed', 'open_questions'], properties: { brief: str, decisions_needed: { type: 'array', items: str }, open_questions: { type: 'array', items: str } } }, (x) => BriefSchema.parse(x));
          if (!r.ok) return r.result;
          await ctx.artifact('meeting_brief', `Meeting brief: ${ctx.run.state.from}`, r.data, r.out.sources);
          return { status: 'done' };
        },
      },
      {
        key: 'next_action',
        label: 'Recording the next action',
        run: async (ctx) => {
          const t = ctx.run.state.triage as z.infer<typeof TriageData>;
          const next =
            t.intent === 'opt_out' || t.opt_out
              ? 'Do not contact again (suppressed).'
              : t.intent === 'automatic_reply'
                ? 'No action: automatic reply. Sequences continue as planned.'
                : t.intent === 'complaint'
                  ? 'Escalate to Bruno: complaint.'
                  : t.intent === 'meeting_request'
                    ? 'Propose meeting times (brief prepared).'
                    : t.intent === 'not_now'
                      ? `Follow up${t.not_before ? ` not before ${t.not_before}` : ' later'}.`
                      : t.intent === 'not_interested'
                        ? 'Close the opportunity; no further outreach.'
                        : t.intent === 'wrong_contact'
                          ? 'Find the right contact; do not repeat to this address.'
                          : 'Reply (draft waits for Bruno).';
          // A question about pricing is never authority for a discount: escalate commercial terms.
          const escalate = t.complaint || t.sensitive || t.questions.some((q) => /\b(discount|price|pricing|sconto|prezzo|desconto|precio)\b/i.test(q));
          await ctx.artifact('next_action', `Next action: ${t.intent}`, { intent: t.intent, next, owner: 'Bruno', escalate, sourceMessage: `message:${ctx.run.state.lastMessageId}` });
          ctx.run.state.summary = `${t.intent}: ${next}`;
          return { status: 'done' };
        },
      },
    ],
  };
}

// ---- WF-01 Prospect to reviewed draft -------------------------------------------

const Candidates = z.object({ candidates: z.array(z.object({ name: z.string(), domain: z.string(), location: z.string(), sourceId: z.string() })) });
const Enriched = z.object({ industry: z.string(), location: z.string(), size: z.string(), public_email: z.string(), phone: z.string(), sources: z.array(z.string()) });
const Account = z.object({ what_they_do: z.string(), recent_news: z.array(z.object({ item: z.string(), date: z.string(), sourceId: z.string() })), open_questions: z.array(z.string()) });
const Draft = z.object({ subject: z.string(), body: z.string(), claims: z.array(z.object({ claim: z.string(), sourceId: z.string() })) });

export function prospectToDraft(d: WorkflowDeps): WorkflowDef {
  return {
    id: 'WF-01',
    version: 1,
    name: 'Prospect to reviewed draft',
    description: 'Research up to 10 candidates that fit the approved ICP, verify and de-duplicate them, brief each one and draft a first-contact email for review. Nothing is sent.',
    roles: ['S02', 'S03', 'S04', 'S05', 'I02', 'S09'],
    input: z.object({ segment: z.string().min(3).max(300), geography: z.string().min(2).max(120), batchLimit: z.number().int().min(1).max(10).default(5), language: z.enum(['en', 'pt', 'es', 'fr', 'it']).default('en') }),
    defaultBudgetEur: 2,
    steps: [
      {
        key: 'preflight',
        label: 'Checking the approved offer and budget',
        run: async (ctx) => {
          const cats = await ctx.brain.approvedCategories(ctx.company.id as CompanyId);
          const blockers: string[] = [];
          if (!cats.has('offer')) blockers.push('Add and approve the company offer in the company brain (category "offer") before drafting outreach');
          if (!d.web) blockers.push('Web research is not configured (needs an AI key)');
          if (ctx.remainingBudget() < 0.2) blockers.push('Budget too small for a research batch');
          return blockers.length ? { status: 'blocked', blockers } : { status: 'done' };
        },
      },
      {
        key: 'icp',
        roleId: 'S02',
        label: 'Loading the ideal customer profile',
        run: async (ctx) => {
          const c = ctx.company.id as CompanyId;
          const icp = await ctx.brain.search(c, `ideal customer profile target segment exclusions ${ctx.run.input.segment}`, { categories: ['icp'], limit: 4 });
          if (icp.length) {
            ctx.run.state.icp = icp.map((k) => ({ sourceId: k.sourceId, locator: k.locator, title: k.title, text: k.text, trusted: true }));
            return { status: 'done' };
          }
          // No approved ICP: propose one and stop for review (blueprint WF-01 step 2).
          const offer = await ctx.brain.search(c, `offer product service ${ctx.run.input.segment}`, { categories: ['offer'], limit: 4 });
          const r = await runRole(ctx, 'S02', `Propose an ICP and exclusions for segment "${ctx.run.input.segment}" in ${ctx.run.input.geography}.`, offer.map((k) => ({ sourceId: k.sourceId, locator: k.locator, title: k.title, text: k.text, trusted: true })), { type: 'object', additionalProperties: false, required: ['icp', 'exclusions'], properties: { icp: str, exclusions: { type: 'array', items: str } } }, (x) => z.object({ icp: z.string(), exclusions: z.array(z.string()) }).parse(x));
          if (!r.ok) return r.result;
          await ctx.artifact('proposed_icp', 'Proposed ideal customer profile', r.data, r.out.sources);
          return { status: 'blocked', blockers: ['No approved ICP yet: review the proposed ICP, then add it to the company brain as category "icp"'] };
        },
      },
      {
        key: 'research',
        roleId: 'S03',
        label: 'Finding candidate organizations',
        run: async (ctx) => {
          const q = `${ctx.run.input.segment} in ${ctx.run.input.geography}: list organizations with their official websites`;
          const found = await d.web!.search(q);
          await d.costs.record('text', `company:${ctx.company.id}:S03`, 0.03);
          ctx.spend(0.03);
          const evidence: Evidence[] = [{ sourceId: 'search:1', title: q, text: found.answer }, ...found.sources.map((s, i) => ({ sourceId: `web:${i + 1}`, title: s.title, text: s.url }))];
          const r = await runRole(ctx, 'S03', `From the research results, list at most ${ctx.run.input.batchLimit} candidate organizations that fit the ICP. domain = their official website domain if evidenced, else "".`, [...(ctx.run.state.icp as Evidence[]), ...evidence], { type: 'object', additionalProperties: false, required: ['candidates'], properties: { candidates: arr({ name: str, domain: str, location: str, sourceId: str }) } }, (x) => Candidates.parse(x));
          if (!r.ok) return r.result;
          ctx.run.state.candidates = r.data.candidates.slice(0, ctx.run.input.batchLimit as number);
          return { status: 'done' };
        },
      },
      {
        key: 'dedupe',
        roleId: 'S05',
        label: 'Removing duplicates and suppressed organizations',
        run: async (ctx) => {
          const c = ctx.company.id as CompanyId;
          const kept: Array<z.infer<typeof Candidates>['candidates'][number]> = [];
          const excluded: Array<{ name: string; reason: string }> = [];
          const seen = new Set<string>();
          for (const cand of ctx.run.state.candidates as Array<z.infer<typeof Candidates>['candidates'][number]>) {
            const dom = canonicalDomain(cand.domain);
            const key = dom ?? cand.name.toLowerCase();
            if (seen.has(key)) {
              excluded.push({ name: cand.name, reason: 'duplicate in this batch' });
              continue;
            }
            seen.add(key);
            if (!dom) {
              excluded.push({ name: cand.name, reason: 'no verified website' });
              continue;
            }
            if (d.suppressions.match({ contactIds: [], addresses: [`x@${dom}`], channel: 'email' })) {
              excluded.push({ name: cand.name, reason: 'on the do-not-contact list' });
              continue;
            }
            const dup = await ctx.crm.findDuplicate(c, 'account', { name: cand.name, domain: dom });
            if (dup.record) {
              excluded.push({ name: cand.name, reason: `already in CRM (${dup.record.id})` });
              continue;
            }
            if (dup.uncertain) {
              excluded.push({ name: cand.name, reason: `possible duplicate of ${dup.uncertain.id}: needs review` });
              continue;
            }
            kept.push({ ...cand, domain: dom });
          }
          ctx.run.state.candidates = kept;
          ctx.run.state.excluded = excluded;
          await ctx.emit('candidates.filtered', { kept: kept.length, excluded });
          return { status: 'done' };
        },
      },
      {
        key: 'enrich_and_brief',
        roleId: 'I02',
        label: 'Verifying and briefing each candidate',
        run: async (ctx) => {
          const out: Array<Record<string, unknown>> = [];
          for (const cand of ctx.run.state.candidates as Array<{ name: string; domain: string; location: string }>) {
            if (ctx.remainingBudget() < 0.1) break;
            let page;
            try {
              page = await d.web!.read(`https://${cand.domain}/`, 12_000);
            } catch (e) {
              out.push({ ...cand, error: `website unreadable: ${(e as Error).message}` });
              continue;
            }
            const ev: Evidence[] = [{ sourceId: `page:${cand.domain}`, title: page.title, text: page.text }];
            const enr = await runRole(ctx, 'S04', `Verify "${cand.name}" (${cand.domain}) and extract evidenced fields. public_email only if it is printed on the page as a business contact address; otherwise "". Unknown fields = "".`, ev, { type: 'object', additionalProperties: false, required: ['industry', 'location', 'size', 'public_email', 'phone', 'sources'], properties: { industry: str, location: str, size: str, public_email: str, phone: str, sources: { type: 'array', items: str } } }, (x) => Enriched.parse(x));
            if (!enr.ok) {
              out.push({ ...cand, error: 'could not verify' });
              continue;
            }
            // Never keep an address that is not literally on the source page.
            const email = enr.data.public_email && page.text.toLowerCase().includes(enr.data.public_email.toLowerCase()) ? enr.data.public_email : '';
            const acct = await runRole(ctx, 'I02', `Dated factual brief for "${cand.name}".`, ev, { type: 'object', additionalProperties: false, required: ['what_they_do', 'recent_news', 'open_questions'], properties: { what_they_do: str, recent_news: arr({ item: str, date: str, sourceId: str }), open_questions: { type: 'array', items: str } } }, (x) => Account.parse(x));
            out.push({ ...cand, ...enr.data, public_email: email, brief: acct.ok ? acct.data : undefined, evidence: ev });
          }
          ctx.run.state.enriched = out;
          return { status: 'done' };
        },
      },
      {
        key: 'draft',
        roleId: 'S09',
        label: 'Drafting first-contact emails for review',
        run: async (ctx) => {
          const c = ctx.company.id as CompanyId;
          const offer = await ctx.brain.search(c, `offer services ${ctx.run.input.segment}`, { categories: ['offer', 'brand', 'claims'], limit: 4 });
          const offerEv: Evidence[] = offer.map((k) => ({ sourceId: k.sourceId, locator: k.locator, title: k.title, text: k.text, trusted: true }));
          let drafted = 0;
          const skipped: Array<{ name: string; reason: string }> = [...((ctx.run.state.excluded as Array<{ name: string; reason: string }>) ?? [])];
          for (const cand of ctx.run.state.enriched as Array<Record<string, any>>) {
            if (cand.error) {
              skipped.push({ name: cand.name, reason: cand.error });
              continue;
            }
            // CRM account proposal (D09-style): created only when Bruno applies it.
            await ctx.crm.propose(c, { kind: 'account', changes: { name: { to: cand.name, source: `page:${cand.domain}` }, domain: { to: cand.domain, source: `page:${cand.domain}` }, industry: { to: cand.industry, source: `page:${cand.domain}` }, location: { to: cand.location || cand.location, source: `page:${cand.domain}` } }, runId: ctx.run.id, reason: `Prospect research: ${cand.name}` });
            if (!cand.public_email) {
              skipped.push({ name: cand.name, reason: 'no verified business email: no address guessed' });
              continue;
            }
            if (canonicalDomain(cand.public_email) !== cand.domain) {
              skipped.push({ name: cand.name, reason: 'email domain does not match the verified website' });
              continue;
            }
            if (ctx.remainingBudget() < 0.05) {
              skipped.push({ name: cand.name, reason: 'budget exhausted' });
              continue;
            }
            const r = await runRole(ctx, 'S09', `Draft a first-contact email in language "${ctx.run.input.language}" to ${cand.public_email} at ${cand.name}. List every factual claim with its sourceId.`, [...offerEv, ...(cand.evidence as Evidence[])], { type: 'object', additionalProperties: false, required: ['subject', 'body', 'claims'], properties: { subject: str, body: str, claims: arr({ claim: str, sourceId: str }) } }, (x) => Draft.parse(x));
            if (!r.ok) {
              skipped.push({ name: cand.name, reason: r.result.status === 'blocked' ? r.result.blockers.join('; ') : 'draft failed' });
              continue;
            }
            const allowed = new Set([...offerEv, ...(cand.evidence as Evidence[])].map((e) => e.sourceId));
            const unsupported = [...detectClaims(r.data.body), ...r.data.claims.filter((cl) => !allowed.has(cl.sourceId)).map((cl) => cl.claim)];
            await ctx.artifact('email_draft', `Draft to ${cand.name}`, { to: cand.public_email, account: cand.name, domain: cand.domain, subject: r.data.subject, body: r.data.body, claims: r.data.claims, flags: unsupported.length ? [`unsupported claims: ${unsupported.join('; ')}`] : [], brief: cand.brief, language: ctx.run.input.language }, r.out.sources);
            drafted++;
          }
          await ctx.artifact('prospect_batch_report', 'Prospect batch report', { drafted, skipped });
          ctx.run.state.summary = `${drafted} drafts ready for review; ${skipped.length} candidates excluded with reasons. Nothing was sent.`;
          return { status: 'done' };
        },
      },
    ],
  };
}
