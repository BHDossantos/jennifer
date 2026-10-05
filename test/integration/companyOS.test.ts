import { describe, expect, it } from 'vitest';
import { createJennifer, createDurableJennifer } from '../../src/app.js';
import { pgliteDb } from '../../src/db/db.js';
import { FakeClock } from '../../src/core/util.js';
import { ScriptedModel, type ModelRequest } from '../../src/core/model.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { buildServer } from '../../src/api/server.js';

const OWNER = { authorization: 'Bearer owner-token-0123456789' };

/** Scripted model: answers by role id found in the system prompt. */
export function roleModel(answers: Record<string, (req: ModelRequest) => object>) {
  return new ScriptedModel((req) => {
    const id = /You are role (\w\d\d)/.exec(req.system)?.[1];
    if (id && answers[id]) return JSON.stringify(answers[id]!(req));
    // Non-company calls (inbound drafts) get a harmless reply.
    return JSON.stringify({ reply: 'Thanks, noted.', cited_memory_ids: [], escalate: false, escalation_reason: '' });
  });
}
const env = (data: object, sources: Array<{ sourceId: string }> = []) => ({ status: 'completed', summary: 'ok', data, sources: sources.map((s) => ({ locator: '', note: '', ...s })), assumptions: [], proposed_actions: [], blockers: [] });

function fakeWeb() {
  const pages: Record<string, string> = {
    'https://brokerone.test/': '<html><title>Broker One</title><p>Broker One is an independent insurance broker in Milan for small businesses.</p><p>Contact: info@brokerone.test</p></html>',
    'https://alpha-logistica.test/': '<html><title>Alpha Logistica</title><p>Logistics company in Milan with 40 trucks.</p><p>Write to us via the form.</p></html>',
  };
  return {
    search: async () => ({ answer: 'Broker One (brokerone.test) and Alpha Logistica (alpha-logistica.test) are Milan businesses.', sources: [{ url: 'https://brokerone.test/', title: 'Broker One' }, { url: 'https://alpha-logistica.test/', title: 'Alpha' }] }),
    read: async (url: string) => {
      if (!pages[url]) throw new Error('404');
      return { url, title: url, text: pages[url]!.replace(/<[^>]+>/g, ' ') };
    },
  };
}

function setup(answers: Record<string, (req: ModelRequest) => object> = {}) {
  const clock = new FakeClock('2026-10-05T07:00:00Z');
  const gmail = new FakeEmailProvider('gmail');
  const j = createJennifer({ clock, model: roleModel(answers), emailConnectors: [gmail], companyWeb: fakeWeb(), inventoryPath: null as never });
  j.capabilities.markConnected('gmail', 'bruno@gmail.test');
  const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner', 'developer-token-0123456789': 'developer' } });
  return { j, app, clock, gmail };
}

async function approvedSource(j: ReturnType<typeof setup>['j'], cid: 'insurance' | 'music', category: string, text: string) {
  const s = await j.companyBrain.addSource(cid, { title: `${category} doc`, category, text }, 'bruno');
  return j.companyBrain.review(cid, s.id, 'approved', 'bruno');
}

describe('Company OS foundation', () => {
  it('seeds Bruno\'s seven companies; the map shows 137 roles with honest readiness; developers cannot see companies', async () => {
    const { app } = setup();
    const list = (await app.inject({ method: 'GET', url: '/v1/companies', headers: OWNER })).json();
    expect(list.map((c: { id: string }) => c.id).sort()).toEqual(['foundation', 'insurance', 'learnnoelia', 'music', 'nonprofit', 'restaurant', 'technology']);
    expect(list.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['SavoryMind', 'B&B Global Services', 'LearnNoelia', 'Esposito Dos Santos Foundation']));
    const map = (await app.inject({ method: 'GET', url: '/v1/companies/insurance/map', headers: OWNER })).json();
    expect(map.totals.roles).toBe(137);
    expect(map.departments.find((d: { id: string }) => d.id === 'marketing').total).toBe(24);
    expect(map.totals.designOnly).toBe(125); // only the 12 pilot roles have executors
    const s09 = (await app.inject({ method: 'GET', url: '/v1/companies/insurance/roles/S09', headers: OWNER })).json();
    expect(s09.readiness).toBe('needs_setup');
    expect(s09.blockers.join(' ')).toMatch(/approve the company offer/);
    expect(s09.configuration.version).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/v1/companies', headers: { authorization: 'Bearer developer-token-0123456789' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/companies/acme/map', headers: OWNER })).json().error).toBe('company.not_found');
  });

  it('runs are persisted before work, idempotent by key, with ordered events and no cross-company visibility', async () => {
    const { j, app } = setup();
    const create = () => app.inject({ method: 'POST', url: '/v1/companies/music/runs', headers: { ...OWNER, 'idempotency-key': 'brief-2026-10-05' }, payload: { workflowId: 'WF-03' } });
    const r1 = await create();
    expect(r1.statusCode).toBe(202);
    const r2 = (await create()).json();
    expect(r2.id).toBe(r1.json().id);
    const run = await j.company.settle('music', r1.json().id);
    expect(run.status).toBe('succeeded');
    const events = (await app.inject({ method: 'GET', url: `/v1/companies/music/runs/${run.id}/events`, headers: OWNER })).json();
    expect(events.map((e: { seq: number }) => e.seq)).toEqual(events.map((_: unknown, i: number) => i + 1));
    expect(events[0].type).toBe('run.queued');
    expect(events.at(-1).type).toBe('run.succeeded');
    const resumeFrom = (await app.inject({ method: 'GET', url: `/v1/companies/music/runs/${run.id}/events?after=3`, headers: OWNER })).json();
    expect(resumeFrom[0].seq).toBe(4);
    // The same run id under another company is "not found".
    expect((await app.inject({ method: 'GET', url: `/v1/companies/insurance/runs/${run.id}`, headers: OWNER })).json().error).toBe('run.not_found');
  });

  it('company brain: new sources are not knowledge until approved; revoked sources vanish; companies never see each other', async () => {
    const { j } = setup();
    const s = await j.companyBrain.addSource('insurance', { title: 'Offer', category: 'offer', text: 'We provide commercial property insurance for SMEs in Lombardy.\n\nNo health insurance.' }, 'bruno');
    expect(s.status).toBe('pending_review');
    expect(await j.companyBrain.search('insurance', 'commercial property insurance')).toHaveLength(0);
    await j.companyBrain.review('insurance', s.id, 'approved', 'bruno');
    expect(await j.companyBrain.search('insurance', 'commercial property insurance')).toHaveLength(1);
    expect(await j.companyBrain.search('music', 'commercial property insurance')).toHaveLength(0);
    await j.companyBrain.review('insurance', s.id, 'revoked', 'bruno');
    expect(await j.companyBrain.search('insurance', 'commercial property insurance')).toHaveLength(0);
  });

  it('CRM changes are versioned: a stale patch is a conflict, never a silent overwrite', async () => {
    const { j } = setup();
    const p1 = await j.companyCrm.propose('insurance', { kind: 'account', changes: { name: { to: 'Broker One' } }, reason: 'test' });
    const { record } = await j.companyCrm.decide('insurance', p1.id, 'apply', 'bruno');
    const a = await j.companyCrm.propose('insurance', { kind: 'account', recordId: record!.id, baseVersion: 1, changes: { stage: { to: 'qualified' } }, reason: 'a' });
    const b = await j.companyCrm.propose('insurance', { kind: 'account', recordId: record!.id, baseVersion: 1, changes: { stage: { to: 'lost' } }, reason: 'b' });
    await j.companyCrm.decide('insurance', a.id, 'apply', 'bruno');
    await expect(j.companyCrm.decide('insurance', b.id, 'apply', 'bruno')).rejects.toThrow(/changed since/);
    expect((await j.companyRepo.record('insurance', record!.id))!.fields.stage).toBe('qualified');
  });
});

describe('WF-03 Daily executive brief', () => {
  it('links every item to a record and drops unreferenced model claims', async () => {
    const { j } = setup({
      O12: (req) => {
        const ref = /\[source (crm:[\w-]+)/.exec(req.input)?.[1] ?? 'none';
        return env({ priorities: [{ title: 'Call the venue', why: 'due today', ref }, { title: 'Invented item', why: 'x', ref: 'crm:fake' }], overdue: [], blockers: [], decisions: [], gaps: [] }, [{ sourceId: ref }]);
      },
    });
    const p = await j.companyCrm.propose('music', { kind: 'task', changes: { title: { to: 'Confirm venue for Nov 14' }, due: { to: '2026-10-05' }, status: { to: 'open' } }, reason: 'test' });
    await j.companyCrm.decide('music', p.id, 'apply', 'bruno');
    const run = await j.company.createRun('bruno', 'music', 'WF-03', {});
    const done = await j.company.settle('music', run.id);
    expect(done.status).toBe('succeeded');
    const [brief] = await j.companyRepo.artifacts('music', run.id);
    const content = brief!.content as { priorities: Array<{ title: string }> };
    expect(content.priorities.map((p) => p.title)).toEqual(['Call the venue']);
  });
});

describe('WF-02 Incoming reply to next action', () => {
  const thread = (j: ReturnType<typeof setup>['j'], from: string, body: string) => {
    const conv = j.conversations.upsertConversation({ ownerId: 'bruno', accountId: 'bruno@gmail.test', channel: 'email', space: 'insurance', providerThreadId: `t-${from}`, subject: 'Your proposal', participantContactIds: [] });
    const m = j.conversations.addMessage({ ownerId: 'bruno', accountId: 'bruno@gmail.test', conversationId: conv.id, providerMessageId: `m-${from}-${body.length}`, direction: 'inbound', channel: 'email', status: 'received', from: { address: from, displayName: 'Laura' }, to: ['bruno@gmail.test'], cc: [], bcc: [], subject: 'Re: Your proposal', body, headers: {}, attachmentIds: [], occurredAt: new Date('2026-10-05T06:00:00Z'), flags: [] });
    return { conv, m };
  };
  const triage = (intent: string, extra: object = {}) => () => env({ intent, source_message_id: 'x', dates: [], questions: [], requested_actions: [], opt_out: intent === 'opt_out', complaint: false, sensitive: false, not_before: '', ...extra });

  it('an opt-out suppresses immediately, cancels pending outreach and pauses follow-ups; the CRM change waits for review', async () => {
    const { j } = setup({ D02: triage('opt_out') });
    const { conv } = thread(j, 'laura@broker.test', 'Please remove me from your list.');
    const t = await j.companyCrm.propose('insurance', { kind: 'task', changes: { title: { to: 'Follow up Laura' }, contact: { to: 'laura@broker.test' }, kind: { to: 'follow_up' }, status: { to: 'open' } }, reason: 'seq' });
    await j.companyCrm.decide('insurance', t.id, 'apply', 'bruno');
    const pending = j.actions.propose({ ownerId: 'bruno', type: 'send_message', space: 'insurance', channel: 'email', connectorId: 'gmail', accountId: 'bruno@gmail.test', payload: { to: ['laura@broker.test'], cc: [], bcc: [], subject: 'Following up', body: 'Hi', attachmentIds: [], evidence: [] }, proposedBy: 'test' });
    const run = await j.company.createRun('bruno', 'insurance', 'WF-02', { conversationId: conv.id });
    expect((await j.company.settle('insurance', run.id)).status).toBe('succeeded');
    expect(j.suppressions.match({ contactIds: [], addresses: ['laura@broker.test'], channel: 'email' })).toBeDefined();
    expect(j.actions.get(pending.id).state).toBe('canceled');
    const task = (await j.companyCrm.records('insurance', 'task'))[0]!;
    expect(task.fields.status).toBe('paused');
    const [patch] = await j.companyRepo.patches('insurance', 'proposed');
    expect(patch!.changes.status!.to).toBe('do_not_contact');
  });

  it('a pricing question is escalated, never treated as authority for a discount; a meeting request gets a brief', async () => {
    const { j, gmail } = setup({ D02: triage('meeting_request', { questions: ['Can you do a discount on the premium?'] }), D05: () => env({ brief: 'Laura runs a broker.', decisions_needed: ['Pricing'], open_questions: [] }) });
    const { conv } = thread(j, 'laura@broker.test', 'Can we meet Thursday? Can you do a discount on the premium?');
    const run = await j.company.createRun('bruno', 'insurance', 'WF-02', { conversationId: conv.id });
    await j.company.settle('insurance', run.id);
    const arts = await j.companyRepo.artifacts('insurance', run.id);
    expect(arts.map((a) => a.kind).sort()).toEqual(['meeting_brief', 'next_action', 'reply_triage']);
    expect((arts.find((a) => a.kind === 'next_action')!.content as { escalate: boolean }).escalate).toBe(true);
    await j.actions.runDue();
    expect(gmail.sent).toHaveLength(0); // nothing sent by the workflow
  });

  it('a conversation from another company cannot be triaged here (scope comes from the stored record)', async () => {
    const { j } = setup({ D02: triage('question') });
    const { conv } = thread(j, 'x@y.test', 'hi');
    const run = await j.company.createRun('bruno', 'music', 'WF-02', { conversationId: conv.id });
    const done = await j.company.settle('music', run.id);
    expect(done.status).toBe('blocked');
    expect(done.blockers).toEqual(['Conversation not found']);
  });
});

describe('WF-01 Prospect to reviewed draft', () => {
  const answers = {
    S02: () => env({ icp: 'Independent brokers', exclusions: ['banks'] }),
    S03: () => env({ candidates: [{ name: 'Broker One', domain: 'brokerone.test', location: 'Milan', sourceId: 'web:1' }, { name: 'Broker One SRL', domain: 'www.brokerone.test', location: 'Milan', sourceId: 'web:1' }, { name: 'Alpha Logistica', domain: 'alpha-logistica.test', location: 'Milan', sourceId: 'web:2' }] }, [{ sourceId: 'web:1' }]),
    S04: (req: ModelRequest) => env(/brokerone/.test(req.input) ? { industry: 'insurance broker', location: 'Milan', size: '', public_email: 'info@brokerone.test', phone: '', sources: [] } : { industry: 'logistics', location: 'Milan', size: '40 trucks', public_email: 'guessed@alpha-logistica.test', phone: '', sources: [] }),
    I02: () => env({ what_they_do: 'Insurance broker', recent_news: [], open_questions: ['Lines of business?'] }),
    S09: () => env({ subject: 'Commercial property cover for your clients', body: 'Hello, we provide commercial property insurance for SMEs in Lombardy.', claims: [{ claim: 'commercial property insurance for SMEs', sourceId: 'OFFER' }] }),
  };

  it('blocks without an approved offer; proposes an ICP and stops when none is approved', async () => {
    const { j } = setup(answers);
    const r1 = await j.company.createRun('bruno', 'insurance', 'WF-01', { segment: 'insurance brokers', geography: 'Milan' });
    expect((await j.company.settle('insurance', r1.id)).blockers.join(' ')).toMatch(/approve the company offer/);
    await approvedSource(j, 'insurance', 'offer', 'We provide commercial property insurance for SMEs in Lombardy.');
    const r2 = await j.company.createRun('bruno', 'insurance', 'WF-01', { segment: 'insurance brokers', geography: 'Milan' });
    const done = await j.company.settle('insurance', r2.id);
    expect(done.status).toBe('blocked');
    expect(done.blockers.join(' ')).toMatch(/No approved ICP/);
    expect((await j.companyRepo.artifacts('insurance', r2.id)).map((a) => a.kind)).toEqual(['proposed_icp']);
  });

  it('dedupes, never guesses an address, drafts only for verified contacts and sends nothing', async () => {
    const { j, gmail } = setup(answers);
    const offer = await approvedSource(j, 'insurance', 'offer', 'We provide commercial property insurance for SMEs in Lombardy.');
    answers.S09 = () => env({ subject: 'Commercial property cover', body: 'Hello, we provide commercial property insurance for SMEs in Lombardy.', claims: [{ claim: 'commercial property insurance', sourceId: offer.id }] });
    await approvedSource(j, 'insurance', 'icp', 'Ideal customer profile: independent insurance brokers in Milan. Exclusions: banks.');
    const run = await j.company.createRun('bruno', 'insurance', 'WF-01', { segment: 'insurance brokers', geography: 'Milan', batchLimit: 5 });
    const done = await j.company.settle('insurance', run.id);
    expect(done.status).toBe('succeeded');
    const arts = await j.companyRepo.artifacts('insurance', run.id);
    const drafts = arts.filter((a) => a.kind === 'email_draft');
    expect(drafts).toHaveLength(1);
    expect((drafts[0]!.content as { to: string; flags: string[] }).to).toBe('info@brokerone.test');
    expect((drafts[0]!.content as { flags: string[] }).flags).toEqual([]);
    const report = arts.find((a) => a.kind === 'prospect_batch_report')!.content as { skipped: Array<{ name: string; reason: string }> };
    expect(report.skipped.map((s) => s.reason).join(' | ')).toMatch(/duplicate in this batch/);
    expect(report.skipped.map((s) => s.reason).join(' | ')).toMatch(/no verified business email/); // the guessed address was dropped
    expect(gmail.sent).toHaveLength(0);
    expect(done.spentEur).toBeLessThanOrEqual(done.budgetEur);
    // Approve → prepare send → waits for Bruno (first contact is never automatic).
    const { app } = { app: buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } }) };
    await app.inject({ method: 'POST', url: `/v1/companies/insurance/artifacts/${drafts[0]!.id}/review`, headers: OWNER, payload: { decision: 'approved' } });
    const prep = (await app.inject({ method: 'POST', url: `/v1/companies/insurance/artifacts/${drafts[0]!.id}/prepare-send`, headers: OWNER })).json();
    expect(prep.state).toBe('awaiting_decision');
    await j.actions.runDue();
    expect(gmail.sent).toHaveLength(0);
  });
});

describe('durability', () => {
  it('a run interrupted mid-way resumes from its last completed step after a restart', async () => {
    const db = await pgliteDb();
    const clock = new FakeClock('2026-10-05T07:00:00Z');
    const j1 = await createDurableJennifer({ db, clock, model: roleModel({}), emailConnectors: [new FakeEmailProvider()], config: { ownerId: 'bruno' } });
    const run = await j1.company.createRun('bruno', 'restaurant', 'WF-03', {});
    await j1.company.settle('restaurant', run.id);
    // Simulate a crash after step 1: mark step 2 pending and the run running.
    const r = (await j1.companyRepo.run('restaurant', run.id))!;
    r.status = 'running';
    r.steps[1]!.status = 'pending';
    await j1.companyRepo.saveRun(r);
    await j1.store.flush();
    const j2 = await createDurableJennifer({ db, clock, model: roleModel({}), emailConnectors: [new FakeEmailProvider()], config: { ownerId: 'bruno' } });
    const done = await j2.company.settle('restaurant', run.id);
    expect(done.status).toBe('succeeded');
    const events = await j2.companyRepo.events('restaurant', run.id, 0);
    expect(events.filter((e) => e.type === 'step.started' && e.data.step === 'collect')).toHaveLength(1); // not repeated
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
    await j2.store.flush();
    await db.close();
  });
});

describe('triggers', () => {
  it('the scheduled brief runs once per local day in the company time zone, only when enabled', async () => {
    const { j, clock } = setup();
    expect(await j.company.tickSchedules()).toEqual([]); // nothing enabled by default
    await j.company.updateProfile('bruno', 'music', { briefTime: '08:30' });
    clock.set(new Date('2026-10-05T06:00:00Z')); // 08:00 Rome (CEST)
    expect(await j.company.tickSchedules()).toEqual([]);
    clock.set(new Date('2026-10-05T06:31:00Z')); // 08:31 Rome
    const [first] = await j.company.tickSchedules();
    expect(first).toBeDefined();
    expect(await j.company.tickSchedules()).toEqual([]); // no duplicate the same day
    clock.set(new Date('2026-10-26T07:31:00Z')); // after DST ends: 08:31 Rome (CET)
    expect(await j.company.tickSchedules()).toHaveLength(1);
    await j.company.settle('music', first!);
  });

  it('auto-triage starts WF-02 for a new message in a company space when enabled, once per message', async () => {
    const { j } = setup({ D02: () => env({ intent: 'question', source_message_id: 'x', dates: [], questions: ['What does it cover?'], requested_actions: [], opt_out: false, complaint: false, sensitive: false, not_before: '' }) });
    await j.company.updateProfile('bruno', 'insurance', { autoTriage: true });
    const email = { accountId: 'bruno@gmail.test', connectorId: 'gmail', providerMessageId: 'pm-1', providerThreadId: 'th-1', from: { address: 'client@firm.test' }, to: ['bruno@gmail.test'], cc: [], subject: 'Cover?', body: 'What does it cover?', headers: {}, occurredAt: new Date(), space: 'insurance' as const };
    await j.inbound.handle(email, { autoDraft: false });
    await j.inbound.handle(email, { autoDraft: false }); // duplicate delivery
    await new Promise((r) => setTimeout(r, 50));
    const runs = await j.companyRepo.runs('insurance', 10);
    expect(runs.filter((r) => r.workflowId === 'WF-02')).toHaveLength(1);
    expect((await j.company.settle('insurance', runs[0]!.id)).status).toBe('succeeded');
  });

  it('renames the old default company names once, never an owner-chosen name', async () => {
    const { MemoryCompanyRepo } = await import('../../src/company/repo.js');
    const { CompanyOS } = await import('../../src/company/engine.js');
    const repo = new MemoryCompanyRepo();
    await repo.saveCompany({ id: 'restaurant', name: 'Restaurant venture', timezone: 'Europe/Rome', locale: 'en', status: 'active', profile: {} });
    await repo.saveCompany({ id: 'technology', name: 'My tech co', timezone: 'Europe/Rome', locale: 'en', status: 'active', profile: {} });
    const os = new CompanyOS({ repo, ownerId: 'bruno' } as never);
    const names = Object.fromEntries((await os.companiesFor('bruno')).map((c) => [c.id, c.name]));
    expect(names).toMatchObject({ restaurant: 'SavoryMind', technology: 'My tech co', learnnoelia: 'LearnNoelia' });
  });
});
