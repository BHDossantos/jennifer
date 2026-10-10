import { describe, expect, it } from 'vitest';
import { createJennifer } from '../../src/app.js';
import { FakeClock } from '../../src/core/util.js';
import { ScriptedModel, type ModelRequest } from '../../src/core/model.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { buildServer } from '../../src/api/server.js';
import { DEPARTMENTS, DEPARTMENT_ROLES, skillsOf } from '../../src/company/departments.js';
import { ROLE_CATALOG } from '../../src/company/catalog.js';

const OWNER = { authorization: 'Bearer owner-token-0123456789' };
const ROUTINE = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOP/fire';
const src = (req: ModelRequest) => /\[source ([\w:-]+)/.exec(req.input)?.[1] ?? 'none';

function setup() {
  const requests: ModelRequest[] = [];
  const model = new ScriptedModel((req) => {
    requests.push(req);
    const dept = /You are role DA-(\w+)/.exec(req.system)?.[1];
    if (dept)
      return JSON.stringify({
        status: 'completed',
        summary: 'ok',
        data: {
          headline: `${dept}: follow up with the two warm catering leads this week.`,
          skillsUsed: [{ skillId: dept === 'sales' ? 'S03' : 'X01', work: 'Reviewed the pipeline' }],
          findings: [{ title: 'Tasting menu is the hero offer', detail: '€45 per person', sourceId: src(req) }],
          proposals: [
            { kind: 'crm_task', skillId: 'S05', title: 'Call the two catering leads', detail: 'Ask about dates and headcount.', sourceId: src(req) },
            { kind: 'claude_task', skillId: 'S08', title: 'Draft a follow-up email in Gmail', detail: 'Draft (do not send) a short follow-up to catering leads offering the €45 tasting menu.', sourceId: src(req) },
            { kind: 'draft', skillId: 'S07', title: 'Call script', detail: 'Hi, this is SavoryMind…', sourceId: src(req) },
          ],
          questions: ['What is the minimum headcount for catering?'],
          notesForNextShift: `${dept}: proposed calling the catering leads; check if Bruno approved.`,
        },
        sources: [{ sourceId: src(req), locator: '', note: '' }],
        assumptions: [],
        proposed_actions: [],
        blockers: [],
      });
    return JSON.stringify({ reply: 'ok', cited_memory_ids: [], escalate: false, escalation_reason: '' });
  });
  const fetchImpl = (async () => new Response(JSON.stringify({ claude_code_session_id: 's1' }), { status: 200 })) as unknown as typeof fetch;
  const clock = new FakeClock('2026-10-10T08:05:00Z');
  const j = createJennifer({ clock, model, fetchImpl, emailConnectors: [new FakeEmailProvider()], inventoryPath: null as never, config: { webhookSecret: 'webhook-secret-0123456789', publicUrl: 'https://jennifer.test', claudeRoutine: { url: ROUTINE, token: 'sk-ant-oat01-token' } } as never });
  const notices: Array<{ title: string; body: string }> = [];
  const notify = j.notifications.notify.bind(j.notifications);
  j.notifications.notify = async (n) => (notices.push(n), notify(n));
  const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
  return { j, app, clock, requests, notices };
}

async function teach(j: ReturnType<typeof setup>['j']) {
  const s = await j.companyBrain.addSource('restaurant', { title: 'Offer', category: 'offer', text: 'SavoryMind restaurant in Milan. Tasting menu €45 per person. Catering for events.' }, 'bruno');
  await j.companyBrain.review('restaurant', s.id, 'approved', 'bruno');
}

const settleAll = async (j: ReturnType<typeof setup>['j'], ids: string[]) => Promise.all(ids.map((id) => j.company.settle('restaurant', id)));

describe('department agents: one per department, on duty around the clock', () => {
  it('every department agent has its department’s skills and a runnable role', () => {
    expect(DEPARTMENT_ROLES.map((r) => r.agentId)).toEqual(DEPARTMENTS.map((d) => `DA-${d}`));
    for (const d of DEPARTMENTS) {
      const skills = skillsOf(d);
      expect(skills.length).toBe(ROLE_CATALOG.filter((r) => r.department === d).length);
      const role = DEPARTMENT_ROLES.find((r) => r.department === d)!;
      for (const s of skills) expect(role.promptTemplate).toContain(`${s.id} ${s.name}`);
      expect(role.actionPolicy).toBe('draft_only');
    }
  });

  it('waits for approved company knowledge, then works a shift per department every 6 hours', async () => {
    const { j, app, clock } = setup();
    expect((await j.company.tickSchedules()).length).toBe(0);
    const before = (await app.inject({ method: 'GET', url: '/v1/companies/restaurant/agents', headers: OWNER })).json();
    expect(before.agents).toHaveLength(7);
    expect(before.agents[0]).toMatchObject({ department: 'sales', name: 'Sales agent', status: 'needs_setup' });
    expect(before.agents[0].skills.length).toBeGreaterThan(10);

    await teach(j);
    const first = await j.company.tickSchedules();
    expect(first).toHaveLength(7); // only the restaurant has approved knowledge
    expect(await j.company.tickSchedules()).toHaveLength(0); // same shift slot: no duplicates
    await settleAll(j, first);

    clock.advance(6 * 3_600_000);
    const second = await j.company.tickSchedules();
    expect(second).toHaveLength(7);
    await settleAll(j, second);

    // Turning one department off, and the whole company's agents off.
    await app.inject({ method: 'PUT', url: '/v1/companies/restaurant/agents', headers: OWNER, payload: { department: 'back_office', on: false } });
    clock.advance(6 * 3_600_000);
    const third = await j.company.tickSchedules();
    expect(third).toHaveLength(6);
    await settleAll(j, third);
    await app.inject({ method: 'PUT', url: '/v1/companies/restaurant/agents', headers: OWNER, payload: { enabled: false } });
    clock.advance(6 * 3_600_000);
    expect(await j.company.tickSchedules()).toHaveLength(0);
    const off = (await app.inject({ method: 'GET', url: '/v1/companies/restaurant/agents', headers: OWNER })).json();
    expect(off.agents.every((a: { status: string }) => a.status === 'off')).toBe(true);
  });

  it('a shift reports, files CRM tasks and Claude tasks for Bruno’s OK, remembers its notes, and never acts alone', async () => {
    const { j, app, requests, notices } = setup();
    await teach(j);
    const r = (await app.inject({ method: 'POST', url: '/v1/companies/restaurant/agents/sales/run', headers: OWNER, payload: { focus: 'catering leads' } })).json();
    const done = await j.company.settle('restaurant', r.id);
    expect(done.status).toBe('succeeded');
    expect(done.summary).toBe('Sales agent: sales: follow up with the two warm catering leads this week.');
    expect(requests.at(-1)!.input).toContain('Bruno asked you to focus on: catering leads');

    const patches = await j.companyRepo.patches('restaurant', 'proposed');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.changes.title!.to).toBe('Call the two catering leads');
    expect((await j.companyRepo.records('restaurant', 'task')).length).toBe(0); // nothing applied without Bruno

    const tasks = j.actions.list({ state: 'awaiting_decision' }).filter((a) => a.type === 'delegate_task');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.space).toBe('restaurant');
    expect((tasks[0]!.payload as { task: string }).task).toContain('Draft a follow-up email in Gmail');

    const report = (await j.companyRepo.artifacts('restaurant', r.id)).find((a) => a.kind === 'department_report')!;
    expect(report.content).toMatchObject({ department: 'sales', questions: ['What is the minimum headcount for catering?'] });
    expect(notices.at(-1)).toMatchObject({ title: 'SavoryMind · Sales agent' });

    const view = (await app.inject({ method: 'GET', url: '/v1/companies/restaurant/agents', headers: OWNER })).json();
    const sales = view.agents.find((a: { department: string }) => a.department === 'sales');
    expect(sales).toMatchObject({ status: 'on_duty', shifts: 1 });
    expect(sales.latestReport.headline).toContain('catering leads');

    // The next shift starts from its own notes.
    const r2 = (await app.inject({ method: 'POST', url: '/v1/companies/restaurant/agents/sales/run', headers: OWNER, payload: {} })).json();
    await j.company.settle('restaurant', r2.id);
    expect(requests.at(-1)!.input).toContain('proposed calling the catering leads');
  });
});
