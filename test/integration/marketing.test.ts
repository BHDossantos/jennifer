import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { createJennifer, createDurableJennifer } from '../../src/app.js';
import { pgliteDb } from '../../src/db/db.js';
import { FakeClock } from '../../src/core/util.js';
import { ScriptedModel, type ModelRequest } from '../../src/core/model.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { buildServer } from '../../src/api/server.js';
import { checkPost, type ReadyPost } from '../../src/company/marketing.js';

const OWNER = { authorization: 'Bearer owner-token-0123456789' };
const ROUTINE = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOP/fire';
const env = (data: object, sources: string[]) => ({ status: 'completed', summary: 'ok', data, sources: sources.map((sourceId) => ({ sourceId, locator: '', note: '' })), assumptions: [], proposed_actions: [], blockers: [] });
const src = (req: ModelRequest) => /\[source ([\w:-]+)/.exec(req.input)?.[1] ?? 'none';

function setup(opts: { claude?: boolean } = {}) {
  const fires: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    fires.push(JSON.parse(String(init.body)).text);
    return new Response(JSON.stringify({ claude_code_session_id: 's1', claude_code_session_url: 'https://claude.ai/code/s1' }), { status: 200 });
  }) as unknown as typeof fetch;
  const model = new ScriptedModel((req) => {
    const id = /You are role (\w\d\d)/.exec(req.system)?.[1];
    if (id === 'M04')
      return JSON.stringify(
        env(
          {
            theme: 'Autumn tasting week',
            posts: [
              { day: '2026-10-13', time: '18:00', channel: 'instagram', format: 'post', idea: 'Tasting menu night', sourceId: src(req) },
              { day: '2026-10-15', time: '12:30', channel: 'facebook', format: 'post', idea: 'Lunch special', sourceId: src(req) },
              { day: '2026-10-16', time: '19:00', channel: 'instagram', format: 'reel', idea: 'Chef at work', sourceId: src(req) },
              { day: '2026-10-17', time: '19:00', channel: 'linkedin', format: 'post', idea: 'Not a requested channel', sourceId: src(req) },
            ],
            adIdeas: [{ platform: 'meta', objective: 'reservations', audience: 'Food lovers in Milan', dailyBudgetEur: 500, headline: 'Tasting menu', primaryText: 'Book your table', sourceId: src(req) }],
          },
          [src(req)],
        ),
      );
    if (id === 'M09')
      return JSON.stringify(
        env(
          {
            captions: [
              { index: 0, caption: 'Our autumn tasting menu is back: €45 per person, Tuesday to Sunday.', hashtags: ['#milano', 'tastingmenu'], imagePrompt: 'Plated pumpkin risotto' },
              { index: 1, caption: 'Lunch is 50% off this week, guaranteed best in Milan!', hashtags: ['lunch'], imagePrompt: 'Lunch table' },
              { index: 2, caption: 'Behind the pass with our chef.', hashtags: ['chef'], imagePrompt: 'Chef plating' },
            ],
          },
          [src(req)],
        ),
      );
    return JSON.stringify({ reply: 'ok', cited_memory_ids: [], escalate: false, escalation_reason: '' });
  });
  const clock = new FakeClock('2026-10-09T08:00:00Z'); // a Friday
  const j = createJennifer({ clock, model, fetchImpl, emailConnectors: [new FakeEmailProvider()], inventoryPath: null as never, config: opts.claude === false ? {} : ({ webhookSecret: 'webhook-secret-0123456789', publicUrl: 'https://jennifer.test', claudeRoutine: { url: ROUTINE, token: 'sk-ant-oat01-token' } } as never) });
  const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
  return { j, app, clock, fires };
}

async function brain(j: ReturnType<typeof setup>['j']) {
  for (const [category, text] of [
    ['offer', 'SavoryMind restaurant in Milan. Autumn tasting menu €45 per person, Tuesday to Sunday. Weekday lunch menu.'],
    ['brand', 'Warm, playful, proudly Italian. Short sentences, no hype.'],
  ] as const) {
    const s = await j.companyBrain.addSource('restaurant', { title: category, category, text }, 'bruno');
    await j.companyBrain.review('restaurant', s.id, 'approved', 'bruno');
  }
}

describe('WF-04 weekly content & social plan (SavoryMind, LearnNoelia…)', () => {
  it('blocks until the offer and brand voice are approved', async () => {
    const { j } = setup();
    const run = await j.company.createRun('bruno', 'learnnoelia', 'WF-04', {});
    const done = await j.company.settle('learnnoelia', run.id);
    expect(done.status).toBe('blocked');
    expect(done.blockers.join(' ')).toMatch(/offer/);
    expect(done.blockers.join(' ')).toMatch(/brand voice/);
  });

  it('plans, writes, drops unapproved claims, and puts each good post in Tasks; nothing is scheduled before Bruno says yes', async () => {
    const { j, fires } = setup();
    await brain(j);
    const run = await j.company.createRun('bruno', 'restaurant', 'WF-04', { channels: ['instagram', 'facebook'], postsPerWeek: 4 });
    const done = await j.company.settle('restaurant', run.id);
    expect(done.status).toBe('succeeded');

    const arts = await j.companyRepo.artifacts('restaurant', run.id);
    const plan = arts.find((a) => a.kind === 'content_plan')!.content as { posts: ReadyPost[]; excluded: Array<{ idea: string; reasons: string[] }> };
    expect(plan.posts.map((p) => p.idea)).toEqual(['Tasting menu night', 'Chef at work']);
    expect(plan.posts[0]!.hashtags).toEqual(['milano', 'tastingmenu']);
    const lunch = plan.excluded.find((e) => e.idea === 'Lunch special')!;
    expect(lunch.reasons.join(' ')).toMatch(/"50%" is not in the approved/);
    expect(lunch.reasons.join(' ')).toMatch(/"guaranteed"|"best"/);
    const ads = arts.find((a) => a.kind === 'ad_ideas')!.content as { ideas: Array<{ dailyBudgetEur: number }> };
    expect(ads.ideas[0]!.dailyBudgetEur).toBe(50); // capped; and only a proposal

    const tasks = j.actions.list({ state: 'awaiting_decision' }).filter((a) => a.type === 'delegate_task');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.space).toBe('restaurant');
    expect((tasks[0]!.payload as { task: string }).task).toContain('Schedule this instagram post for the brand "SavoryMind" in Metricool on 2026-10-13 at 18:00');
    expect((tasks[0]!.payload as { task: string }).task).toContain('€45 per person');
    await j.actions.runDue();
    expect(fires).toHaveLength(0);

    j.actions.approve(tasks[0]!.id, 'bruno', { revision: tasks[0]!.revision, payloadHash: tasks[0]!.payloadHash });
    await j.actions.runDue();
    expect(fires).toHaveLength(1);
    expect(JSON.parse(fires[0]!).category).toBe('social');
  });

  it('without Claude connected, the plan is kept and the run says what to connect', async () => {
    const { j } = setup({ claude: false });
    await brain(j);
    const run = await j.company.createRun('bruno', 'restaurant', 'WF-04', {});
    const done = await j.company.settle('restaurant', run.id);
    expect(done.status).toBe('blocked');
    expect(done.blockers.join(' ')).toMatch(/connect your Claude routine/);
    expect(j.actions.list({ state: 'awaiting_decision' }).filter((a) => a.type === 'delegate_task')).toHaveLength(0);
  });

  it('weekly opt-in runs once on Friday for next week; the dating app can be renamed', async () => {
    const { j, app } = setup();
    await j.company.updateProfile('bruno', 'restaurant', { weeklyContent: true });
    const first = await j.company.tickSchedules();
    const again = await j.company.tickSchedules();
    expect(first).toHaveLength(1);
    expect(again).toHaveLength(0);
    const run = await j.companyRepo.run('restaurant', first[0]!);
    expect(run?.input).toMatchObject({ weekOf: '2026-10-12' });

    const r = await app.inject({ method: 'PUT', url: '/v1/companies/dating/name', headers: OWNER, payload: { name: 'Amore' } });
    expect(r.json().name).toBe('Amore');
  });

  it('the deterministic check catches length, dates and risky words', () => {
    const start = DateTime.fromISO('2026-10-12', { zone: 'Europe/Rome' });
    const end = start.plus({ days: 6 });
    const base: ReadyPost = { day: '2026-10-13', time: '18:00', channel: 'x', format: 'post', idea: 'x', caption: 'Hello', hashtags: [], imagePrompt: '' };
    expect(checkPost(base, '', start, end)).toEqual([]);
    expect(checkPost({ ...base, caption: 'a'.repeat(300) }, '', start, end).join()).toMatch(/too long for x/);
    expect(checkPost({ ...base, day: '2026-11-01' }, '', start, end).join()).toMatch(/outside the planned week/);
    expect(checkPost({ ...base, caption: 'Free dessert tonight' }, 'free dessert on tuesdays', start, end)).toEqual([]);
    expect(checkPost({ ...base, caption: 'Free dessert tonight' }, 'dessert', start, end).join()).toMatch(/"Free"/);
  });

  it('reads all approved brand and offer material from Postgres too (not only keyword matches)', async () => {
    const db = await pgliteDb();
    const j = await createDurableJennifer({ db, clock: new FakeClock('2026-10-09T08:00:00Z'), emailConnectors: [new FakeEmailProvider()], config: { ownerId: 'bruno' } });
    await brain(j as never);
    const s = await j.companyBrain.addSource('restaurant', { title: 'draft', category: 'offer', text: 'Unapproved idea: 2-for-1 Mondays' }, 'bruno');
    const got = await j.companyBrain.approved('restaurant', ['offer', 'brand']);
    expect(got.map((c) => c.text).join(' ')).toContain('€45 per person');
    expect(got.map((c) => c.text).join(' ')).toContain('proudly Italian');
    expect(got.some((c) => c.sourceId === s.id)).toBe(false);
    await db.close();
  });
});
