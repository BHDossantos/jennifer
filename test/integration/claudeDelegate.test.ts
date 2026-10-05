import { describe, expect, it } from 'vitest';
import { createJennifer } from '../../src/app.js';
import { FakeClock } from '../../src/core/util.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { buildServer } from '../../src/api/server.js';
import { ClaudeRoutineDelegate } from '../../src/delegate/claudeRoutine.js';

const ROUTINE = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOP/fire';
const OWNER = 'owner-token-0123456789';
const ctx = { ownerId: 'bruno', role: 'chat', allowedTools: new Set(['ask_claude_to_do']), scopes: new Set(['delegate:propose']) };

function setup(opts: { configured?: boolean; status?: number } = {}) {
  const fires: Array<{ url: string; headers: Record<string, string>; text: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    fires.push({ url, headers: init.headers as Record<string, string>, text: JSON.parse(String(init.body)).text });
    if (opts.status) return new Response('nope', { status: opts.status });
    return new Response(JSON.stringify({ type: 'routine_fire', claude_code_session_id: 'session_01X', claude_code_session_url: 'https://claude.ai/code/session_01X' }), { status: 200 });
  }) as unknown as typeof fetch;
  const j = createJennifer({
    clock: new FakeClock('2026-10-05T10:00:00Z'),
    emailConnectors: [new FakeEmailProvider()],
    fetchImpl,
    inventoryPath: null as never,
    config: {
      webhookSecret: 'webhook-secret-0123456789',
      publicUrl: 'https://jennifer-test.onrender.com',
      claudeRoutine: opts.configured === false ? {} : { url: ROUTINE, token: 'sk-ant-oat01-routine-token' },
    } as never,
  });
  const notices: Array<{ title: string; body: string }> = [];
  const notify = j.notifications.notify.bind(j.notifications);
  j.notifications.notify = async (n) => (notices.push(n), notify(n));
  const app = buildServer(j, { tokens: { [OWNER]: 'owner' } });
  return { j, app, fires, notices };
}

const TASK = 'Book "Dentist" in my Google Calendar on Tuesday 14 October 2026, 15:00-16:00 Europe/Rome, no attendees.';

describe('Claude does hands-on tasks through Bruno’s routine', () => {
  it('waits for Bruno, fires the routine once with the exact task, and settles on a signed report', async () => {
    const { j, app, fires, notices } = setup();
    // Even a blanket "autopilot" grant does not let Jennifer delegate without asking.
    j.authority.grant({ principal: 'bruno', action: 'delegate_task', mode: 'execute', scope: {}, limits: {}, note: 'template:autopilot' });
    const p = (await j.tools.invoke('ask_claude_to_do', { task: TASK, category: 'calendar' }, ctx)) as { actionId: string; state: string };
    expect(p.state).toBe('awaiting_decision');
    await j.actions.runDue();
    expect(fires).toHaveLength(0);

    const card = (await app.inject({ method: 'GET', url: `/v1/actions/${p.actionId}`, headers: { authorization: `Bearer ${OWNER}` } })).json();
    expect(card).toMatchObject({ type: 'delegate_task', body: TASK, recipients: ['Claude (with your connected accounts)'] });

    const a = j.actions.get(p.actionId);
    j.actions.approve(a.id, 'bruno', { revision: a.revision, payloadHash: a.payloadHash });
    await j.actions.runDue();
    expect(fires).toHaveLength(1);
    expect(fires[0]!.url).toBe(ROUTINE);
    expect(fires[0]!.headers).toMatchObject({ authorization: 'Bearer sk-ant-oat01-routine-token', 'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'anthropic-version': '2023-06-01' });
    const sent = JSON.parse(fires[0]!.text);
    expect(sent).toMatchObject({ actionId: a.id, task: TASK, category: 'calendar', approvedByBruno: true });
    expect(sent.report.url).toBe('https://jennifer-test.onrender.com/v1/webhooks/claude-routine');
    expect(j.actions.get(a.id).state).toBe('provider_accepted');
    expect(j.actions.get(a.id).receipt?.evidence).toContain('https://claude.ai/code/session_01X');

    // A report without the per-task token is refused; a token for another task is refused too.
    const report = (body: object) => app.inject({ method: 'POST', url: '/v1/webhooks/claude-routine', payload: body });
    expect((await report({ actionId: a.id, token: 'forged-token-123', status: 'done', summary: 'x' })).statusCode).toBe(401);
    expect((await report({ actionId: 'other', token: sent.report.json.token, status: 'done', summary: 'x' })).statusCode).toBe(401);

    const ok = await report({ actionId: a.id, token: sent.report.json.token, status: 'done', summary: 'Booked Dentist on Tue 14 Oct 15:00-16:00 Europe/Rome.' });
    expect(ok.statusCode).toBe(200);
    expect(j.actions.get(a.id).state).toBe('confirmed');
    expect(notices.at(-1)).toMatchObject({ title: 'Claude finished a task', body: 'Booked Dentist on Tue 14 Oct 15:00-16:00 Europe/Rome.' });
    expect((await report({ actionId: a.id, token: sent.report.json.token, status: 'done', summary: 'again' })).json()).toMatchObject({ duplicate: true });
    await j.actions.runDue();
    expect(fires).toHaveLength(1); // never fired twice
  });

  it('a failed or unclear task is reported to Bruno as a problem', async () => {
    const { j, app, fires, notices } = setup();
    const p = (await j.tools.invoke('ask_claude_to_do', { task: TASK, category: 'calendar' }, ctx)) as { actionId: string };
    const a = j.actions.get(p.actionId);
    j.actions.approve(a.id, 'bruno', { revision: a.revision, payloadHash: a.payloadHash });
    await j.actions.runDue();
    const token = JSON.parse(fires[0]!.text).report.json.token;
    await app.inject({ method: 'POST', url: '/v1/webhooks/claude-routine', payload: { actionId: a.id, token, status: 'needs_input', summary: 'You already have a meeting at 15:00.' } });
    expect(j.actions.get(a.id).state).toBe('failed');
    expect(notices.at(-1)).toMatchObject({ title: 'Claude needs more detail' });
  });

  it('cannot run until Claude is connected, and a rejected token fails without retrying', async () => {
    const off = setup({ configured: false });
    const p = (await off.j.tools.invoke('ask_claude_to_do', { task: TASK, category: 'calendar' }, ctx)) as { actionId: string; state: string };
    expect(off.j.actions.get(p.actionId).decisionReasons.join(' ')).toMatch(/Claude is not connected/);
    expect(off.fires).toHaveLength(0);

    const bad = setup({ status: 401 });
    const q = (await bad.j.tools.invoke('ask_claude_to_do', { task: TASK, category: 'calendar' }, ctx)) as { actionId: string };
    const a = bad.j.actions.get(q.actionId);
    bad.j.actions.approve(a.id, 'bruno', { revision: a.revision, payloadHash: a.payloadHash });
    await bad.j.actions.runDue();
    expect(bad.j.actions.get(a.id).state).toBe('failed');
    expect(bad.fires).toHaveLength(1);
  });

  it('only accepts the official routine fire URL and exposes setup help', async () => {
    expect(() => new ClaudeRoutineDelegate({ routineUrl: 'https://evil.example/fire' })).toThrow(/routine fire URL/);
    const { app } = setup();
    const d = (await app.inject({ method: 'GET', url: '/v1/delegate', headers: { authorization: `Bearer ${OWNER}` } })).json();
    expect(d).toMatchObject({ configured: true, callbackHost: 'jennifer-test.onrender.com' });
    expect(d.routinePrompt).toMatch(/routine-fire-payload/);
    expect(d.routinePrompt).toMatch(/Never send money/);
  });
});
