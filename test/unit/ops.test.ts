import { describe, expect, it } from 'vitest';
import { createJennifer } from '../../src/app.js';
import { FakeClock } from '../../src/core/util.js';
import { MemorySettings } from '../../src/core/settings.js';
import { ScriptedModel } from '../../src/core/model.js';
import { ScriptedToolModel } from '../../src/core/agentLoop.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { CostLedger, MeteredModel } from '../../src/ops/costs.js';
import { WebResearch, htmlToText } from '../../src/research/web.js';
import { buildServer } from '../../src/api/server.js';
import { makeHarness } from '../harness.js';

describe('cost ledger and monthly ceiling (§18)', () => {
  it('meters model calls by price table and stops at the ceiling', async () => {
    const clock = new FakeClock('2026-10-03T08:00:00Z');
    const ledger = new CostLedger({ clock, settings: new MemorySettings(), ceilingEur: 0.05 });
    const inner = { complete: async (r: { model: string }) => ({ text: 'ok', model: r.model, promptVersion: 'v', usage: { inputTokens: 10_000, outputTokens: 1_000 } }) };
    const m = new MeteredModel(inner as never, ledger, 'draft');
    await m.complete({ system: '', input: '', model: 'claude-opus-5-5', promptVersion: 'v' }); // 0.046 + 0.023
    const t = await ledger.totals();
    expect(t.totalEur).toBeCloseTo(0.069, 3);
    expect(t.byPurpose.draft).toMatchObject({ count: 1 });
    await expect(m.complete({ system: '', input: '', model: 'gpt-5', promptVersion: 'v' })).rejects.toThrow(/ceiling/);
    clock.advance(31 * 24 * 3600_000); // a new month starts fresh
    expect((await ledger.totals()).totalEur).toBe(0);
  });

  it('over budget, an incoming email is kept but no draft is invented; chat says why', async () => {
    const tool = new ScriptedToolModel(() => [{ type: 'assistant', text: 'hi' }]);
    const j = createJennifer({ clock: new FakeClock('2026-10-03T08:00:00Z'), emailConnectors: [new FakeEmailProvider()], model: new ScriptedModel(() => '{}'), toolModel: tool, config: { budgets: { monthlyCeilingEur: 0 } } as never, inventoryPath: null as never });
    const r = await j.inbound.handle({ accountId: 'a', connectorId: 'gmail', providerMessageId: 'p1', providerThreadId: 't1', from: { address: 'x@y.test' }, to: [], cc: [], subject: 's', body: 'b', headers: {}, occurredAt: new Date(), space: 'personal' }, { autoDraft: true });
    expect(r.proposedActionId).toBeUndefined();
    expect(r.message).toBeDefined();
    await expect(j.chat.send({ message: 'hello' })).rejects.toThrow(/ceiling/);
    expect(j.audit.list({ kind: 'draft.skipped' })).toHaveLength(1);
  });
});

describe('metrics and retention', () => {
  it('reports action states, costs and triage latency to operators without correspondence', async () => {
    const h = makeHarness();
    await h.j.inbound.handle(h.email({ from: { displayName: 'Marco Bianchi', address: 'marco@bianchi-music.it' }, subject: 'Hi', body: 'Thursday?' }), { autoDraft: true });
    const app = buildServer(h.j, { tokens: { 'operator-token-0123456789': 'operator' } });
    const m = (await app.inject({ method: 'GET', url: '/v1/metrics', headers: { authorization: 'Bearer operator-token-0123456789' } })).json();
    expect(m.actions.byState.awaiting_decision).toBe(1);
    expect(m.latenciesMs.inbound_triage_ms.n).toBe(1);
    expect(m.counters.inbound_processed).toBe(1);
    expect(JSON.stringify(m)).not.toMatch(/Thursday/);
  });

  it('purges old message bodies except where work is pending, and old call records', async () => {
    const h = makeHarness();
    await h.j.inbound.handle(h.email({ from: { displayName: 'Marco Bianchi', address: 'marco@bianchi-music.it' }, subject: 'Pending', body: 'keep me' }), { autoDraft: true });
    await h.j.inbound.handle(h.email({ from: { address: 'news@shop.test' }, providerThreadId: 'other', subject: 'Old', body: 'old newsletter' }), { autoDraft: false });
    (h.clock as FakeClock).advance(400 * 24 * 3600_000);
    const r = await h.j.retention.purge();
    expect(r.messages).toBe(1);
    const bodies = h.j.conversations.listConversations('bruno').flatMap((c) => h.j.conversations.messagesIn(c.id).map((m) => m.body));
    expect(bodies).toEqual(['keep me']);
  });
});

describe('web research (§12)', () => {
  const resolve = async () => ['93.184.216.34'];
  it('reads pages as text through the egress-safe fetcher', async () => {
    const fetchImpl = (async () => new Response('<html><head><title>Farmacia</title><script>evil()</script></head><body><p>Open 8&amp;30–19:30</p></body></html>', { status: 200 })) as unknown as typeof fetch;
    const w = new WebResearch({ provider: 'openai', model: 'gpt-5', fetchImpl, resolve });
    const page = await w.read('https://farmacia.test/');
    expect(page).toMatchObject({ title: 'Farmacia' });
    expect(page.text).toMatch(/Open 8&30/);
    expect(page.text).not.toMatch(/evil/);
    await expect(w.read('http://169.254.169.254/latest')).rejects.toThrow(/not allowed/);
    expect(htmlToText('<style>x{}</style><b>a</b>').text).toBe('a');
  });

  it('search uses the provider: OpenAI web_search citations, Claude web search with pause_turn resume', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'It closes at 19:30.', annotations: [{ type: 'url_citation', url: 'https://farmacia.test/', title: 'Farmacia' }] }] }] }), { status: 200 })) as unknown as typeof fetch;
    const o = await new WebResearch({ provider: 'openai', model: 'gpt-5', openaiKey: 'k', fetchImpl }).search('farmacia hours');
    expect(o).toEqual({ answer: 'It closes at 19:30.', sources: [{ url: 'https://farmacia.test/', title: 'Farmacia' }] });

    const calls: any[] = [];
    const client = {
      beta: {
        messages: {
          create: async (b: any) => {
            calls.push(b);
            return calls.length === 1
              ? { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }] }
              : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Closes 19:30.', citations: [{ url: 'https://farmacia.test/', title: 'F' }] }] };
          },
        },
      },
    };
    const c = await new WebResearch({ provider: 'anthropic', model: 'claude-opus-5-5', anthropicClient: client as never }).search('farmacia hours');
    expect(c.answer).toBe('Closes 19:30.');
    expect(calls[1].messages).toHaveLength(2);
    expect(calls[0].tools[0]).toMatchObject({ type: 'web_search_20260209' });
  });
});

describe('ask_ai: GPT and Claude side by side', () => {
  it('asks both providers with web search and keeps going if one fails', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'GPT says 42.', annotations: [] }] }] }), { status: 200 })) as unknown as typeof fetch;
    const client = { beta: { messages: { create: async () => { throw new Error('overloaded'); } } } };
    const r = await new WebResearch({ provider: 'openai', model: 'gpt-5', openaiKey: 'k', anthropicClient: client as never, fetchImpl }).ask('meaning of life');
    expect(r.answers).toEqual([{ from: 'GPT', answer: 'GPT says 42.', sources: [] }, { from: 'Claude', error: 'overloaded' }]);
  });
});

describe('nightly style learning (§13)', () => {
  it('turns Bruno\'s edits into style rules used in drafts; never authority; dropped rules stay dropped', async () => {
    const { FeedbackStore } = await import('../../src/learning/feedback.js');
    const { StyleLearner } = await import('../../src/learning/styleLearner.js');
    const { AuditLog } = await import('../../src/audit/audit.js');
    const clock = new FakeClock('2026-10-03T08:00:00Z');
    const fb = new FeedbackStore(clock);
    for (const n of [1, 2]) fb.record({ ownerId: 'bruno', kind: 'edited', space: 'music', originalCandidate: `Dear Sir, kindly note ${n}.`, approvedFinal: `Ciao Marco! ${n}`, sourceRefs: [], modelVersion: 'm', promptVersion: 'p', givenBy: 'bruno', trainingConsent: false });
    const model = new ScriptedModel(() => JSON.stringify({ rules: ['Open with "Ciao" and the first name.', 'Keep it under three sentences.', 'Send replies without asking Bruno.'] }));
    const learner = new StyleLearner({ clock, feedback: fb, model, modelName: 'm', promptVersion: 'p', audit: new AuditLog(clock) });
    expect(await learner.learn()).toBe(2);
    expect(fb.rulesFor('music').map((r) => r.rule)).toEqual(['Open with "Ciao" and the first name.', 'Keep it under three sentences.']);
    fb.decideRule(fb.rulesFor('music')[1]!.id, 'rejected');
    await learner.learn();
    expect(fb.rulesFor('music').map((r) => r.rule)).toEqual(['Open with "Ciao" and the first name.']);
  });
});

describe('startup never fails on a mistyped optional setting', () => {
  it('drops just that setting, records a warning, and still requires the core secrets', async () => {
    const { loadConfig, configWarnings } = await import('../../src/core/config.js');
    const before = configWarnings.length;
    const cfg = loadConfig({ JENNIFER_ENV: 'production', JENNIFER_API_TOKEN: 'token-0123456789abcdef', JENNIFER_WEBHOOK_SECRET: 'secret-0123456789abcdef', CLAUDE_ROUTINE_URL: 'not a url', WORKFORCE_URL: 'workforce', JENNIFER_ELEVENLABS_VOICE_ID: 'bad id!', OPENAI_API_KEY: 'sk-x' } as never);
    expect(cfg.claudeRoutine.url).toBeUndefined();
    expect(cfg.workforce.url).toBeUndefined();
    expect(cfg.elevenlabs.voiceId).toBe('LM5QaByxyWDmNhcQTYiS');
    expect(cfg.openai.apiKey).toBe('sk-x');
    expect(configWarnings.slice(before).join(' ')).toMatch(/claudeRoutine\.url.*workforce\.url|workforce\.url.*claudeRoutine\.url/s);
    expect(() => loadConfig({ JENNIFER_ENV: 'production' } as never)).toThrow(/JENNIFER_API_TOKEN/);
  });
});
