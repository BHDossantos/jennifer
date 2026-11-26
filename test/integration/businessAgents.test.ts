import { describe, expect, it } from 'vitest';
import { createJennifer } from '../../src/app.js';
import { FakeClock } from '../../src/core/util.js';
import { ScriptedModel, type ModelRequest } from '../../src/core/model.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { buildServer } from '../../src/api/server.js';
import { BUSINESS_AGENTS, FOCUS_MAX, SHARED_APPROVALS, taskFocus } from '../../src/company/businessAgents.js';
import { DEPARTMENTS } from '../../src/company/departments.js';
import { COMPANY_IDS } from '../../src/company/model.js';

const OWNER = { authorization: 'Bearer owner-token-0123456789' };
const src = (req: ModelRequest) => /\[source ([\w:-]+)/.exec(req.input)?.[1] ?? 'none';

function setup() {
  const requests: ModelRequest[] = [];
  const model = new ScriptedModel((req) => {
    requests.push(req);
    if (/You are role DA-(\w+)/.test(req.system))
      return JSON.stringify({
        status: 'completed',
        summary: 'ok',
        data: {
          headline: 'Two restaurant contacts are ready for a first message.',
          skillsUsed: [{ skillId: 'S03', work: 'Qualified contacts' }],
          findings: [{ title: 'Owner-run trattorie fit the offer', detail: 'From the ICP', sourceId: src(req) }],
          proposals: [{ kind: 'crm_task', skillId: 'S05', title: 'Send the first email to Trattoria Uno', detail: 'Use the approved offer.', sourceId: src(req) }],
          questions: [],
          notesForNextShift: 'Check whether Bruno approved the first email.',
        },
        sources: [{ sourceId: src(req), locator: '', note: '' }],
        assumptions: [],
        proposed_actions: [],
        blockers: [],
      });
    return JSON.stringify({ reply: 'ok', cited_memory_ids: [], escalate: false, escalation_reason: '' });
  });
  const clock = new FakeClock('2026-11-26T08:05:00Z');
  const j = createJennifer({ clock, model, emailConnectors: [new FakeEmailProvider()], inventoryPath: null as never, config: { webhookSecret: 'webhook-secret-0123456789', publicUrl: 'https://jennifer.test' } as never });
  const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
  return { j, app, requests };
}

describe('business agents: one lead agent per business', () => {
  it('every company has a charter whose tasks run on a real department agent', () => {
    expect(Object.keys(BUSINESS_AGENTS).sort()).toEqual([...COMPANY_IDS].sort());
    for (const a of Object.values(BUSINESS_AGENTS)) {
      expect(a.tasks.length).toBeGreaterThan(0);
      expect(new Set(a.tasks.map((t) => t.id)).size).toBe(a.tasks.length);
      for (const t of a.tasks) {
        expect(DEPARTMENTS).toContain(t.department);
        expect(t.approval.length).toBeGreaterThan(0);
        const focus = taskFocus(a, t);
        expect(focus.length).toBeLessThanOrEqual(FOCUS_MAX);
        expect(focus).toContain(t.name);
      }
    }
  });

  it('shows the charter with its approval points and the routine it works alongside', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/v1/companies/restaurant/business-agent', headers: OWNER });
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c).toMatchObject({ name: 'SavoryMind agent', routine: { name: 'savoryMind' }, sharedApprovals: SHARED_APPROVALS });
    expect(c.tasks.find((t: { id: string }) => t.id === 'prospects')).toMatchObject({ department: 'sales', carriedOutBy: 'Sales agent', lastRun: null });
    const all = (await app.inject({ method: 'GET', url: '/v1/business-agents', headers: OWNER })).json();
    expect(all).toHaveLength(COMPANY_IDS.length);
    expect((await app.inject({ method: 'GET', url: '/v1/companies/dating/business-agent', headers: OWNER })).json().name).toBe('Lovera agent');
  });

  it('runs a task as a department shift with the business focus; the result only proposes', async () => {
    const { j, app, requests } = setup();
    const s = await j.companyBrain.addSource('restaurant', { title: 'Offer', category: 'offer', text: 'SavoryMind gives independent restaurants menu and cost intelligence.' }, 'bruno');
    await j.companyBrain.review('restaurant', s.id, 'approved', 'bruno');
    const r = (await app.inject({ method: 'POST', url: '/v1/companies/restaurant/business-agent/tasks/prospects/run', headers: OWNER })).json();
    const done = await j.company.settle('restaurant', r.id);
    expect(done.status).toBe('succeeded');
    expect(done.input).toMatchObject({ department: 'sales', businessTask: 'prospects' });
    expect(requests.at(-1)!.input).toContain('SavoryMind agent · Qualify restaurant contacts');
    expect(requests.at(-1)!.input).toContain('no invented customers');
    // Nothing applied or sent: the CRM change waits for Bruno.
    expect(await j.companyRepo.patches('restaurant', 'proposed')).toHaveLength(1);
    expect((await j.companyRepo.records('restaurant', 'task')).length).toBe(0);
    const view = (await app.inject({ method: 'GET', url: '/v1/companies/restaurant/business-agent', headers: OWNER })).json();
    expect(view.tasks.find((t: { id: string }) => t.id === 'prospects').lastRun).toMatchObject({ runId: r.id, status: 'succeeded' });
  });

  it('an unknown task is not found', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/companies/music/business-agent/tasks/nope/run', headers: OWNER });
    expect(res.statusCode).toBe(404);
  });

  it('chat and voice can list and run business tasks', async () => {
    const { j } = setup();
    const list = (await j.tools.invoke('business_agent_task', { companyId: 'music' }, { ownerId: 'bruno', role: 'jennifer', allowedTools: new Set(['business_agent_task']), scopes: new Set(['company:run']) })) as { tasks: Array<{ id: string }> };
    expect(list.tasks.map((t) => t.id)).toEqual(['pitches', 'content', 'numbers']);
  });
});
