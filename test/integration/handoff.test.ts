import { describe, expect, it } from 'vitest';
import { createJennifer } from '../../src/app.js';
import { FakeClock } from '../../src/core/util.js';
import { ScriptedModel } from '../../src/core/model.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { buildServer } from '../../src/api/server.js';
import { isAffirmative } from '../../src/assistant/handoff.js';

const TOKEN = 'imessage-webhook-token-0123456789';
const ANA = '+393409998888';

function setup() {
  const sent: Array<{ chatGuid: string; message: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (init?.method === 'POST' && u.pathname.endsWith('/message/text')) {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ status: 200, data: { guid: `p:${sent.length}` } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const systems: string[] = [];
  const inputs: string[] = [];
  const model = new ScriptedModel((req) => {
    systems.push(req.system);
    inputs.push(req.input);
    const asksBot = /are you a bot|is this a bot/i.test(req.input);
    return JSON.stringify({ reply: asksBot ? "It's Jennifer, Bruno's assistant, helping him reply." : 'Sunday at 8 works! See you then.', cited_memory_ids: [], escalate: asksBot, escalation_reason: asksBot ? 'asked whether this is an AI' : '' });
  });
  const clock = new FakeClock('2026-10-07T17:00:00Z');
  const j = createJennifer({
    clock,
    model,
    emailConnectors: [new FakeEmailProvider()],
    fetchImpl,
    inventoryPath: null as never,
    config: { imessage: { url: 'https://bruno-mac.example', password: 'mac-pass', webhookToken: TOKEN, method: 'apple-script' } } as never,
  });
  const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
  let n = 0;
  const ana = (text: string) =>
    app.inject({ method: 'POST', url: `/v1/webhooks/imessage?token=${TOKEN}`, payload: { type: 'new-message', data: { guid: `a${++n}`, text, isFromMe: false, dateCreated: clock.now().getTime(), handle: { address: ANA }, chats: [{ guid: `iMessage;-;${ANA}` }] } } });
  const brunoTypes = (text: string) =>
    app.inject({ method: 'POST', url: `/v1/webhooks/imessage?token=${TOKEN}`, payload: { type: 'new-message', data: { guid: `b${++n}`, text, isFromMe: true, dateCreated: clock.now().getTime(), handle: null, chats: [{ guid: `iMessage;-;${ANA}` }] } } });
  const ctx = (words: string) => ({ ownerId: 'bruno', role: 'voice', allowedTools: new Set(['save_contact', 'message_someone', 'confirm_send', 'stop_handling', 'get_debrief']), scopes: new Set(['messages:start', 'debrief:read']), ownerWords: words, ownerWordsAt: clock.now() });
  return { j, app, sent, systems, inputs, clock, ana, brunoTypes, ctx };
}

describe('Jarvis mode: "text my sister and sort out dinner"', () => {
  it('only a clear yes counts', () => {
    for (const y of ['yes', 'Yes, send it', 'go ahead', 'ok', 'sim, manda', 'Jennifer yes']) expect(isAffirmative(y)).toBe(true);
    for (const n of ['no', 'wait', 'yes but change the time', 'maybe', 'send it to mom instead and also tell her about the party please ok', '']) expect(isAffirmative(n)).toBe(false);
  });

  it('saves the sister, reads back, sends on yes, handles replies toward the goal, escalates, steps back, and debriefs', async () => {
    const { j, sent, systems, inputs, clock, ana, brunoTypes, ctx } = setup();

    // Numbers are saved only when Bruno said them himself.
    await expect(j.tools.invoke('save_contact', { name: 'Ana', phone: ANA, relation: 'sister' }, ctx('my sister is Ana'))).rejects.toThrow(/say or type the number yourself/);
    await j.tools.invoke('save_contact', { name: 'Ana', phone: ANA, relation: 'sister' }, ctx('my sister is Ana, +39 340 999 8888'));

    const p = (await j.tools.invoke('message_someone', { who: 'my sister', message: 'Hey Ana! Dinner on Sunday?', handle_replies: true, goal: 'agree a time for dinner on Sunday', hours: 24 }, ctx('text my sister, ask her about dinner Sunday and sort it out'))) as { ok: boolean; readback: string; handoffId: string };
    expect(p.ok).toBe(true);
    expect(p.readback).toContain('iMessage to Ana (+393409998888): "Hey Ana! Dinner on Sunday?"');
    expect(sent).toHaveLength(0);

    // Not a yes, or a yes given before she read it back: nothing is sent.
    clock.advance(5_000);
    await expect(j.tools.invoke('confirm_send', {}, ctx('hmm, maybe later'))).rejects.toThrow(/clear yes/);
    await expect(j.tools.invoke('confirm_send', {}, { ...ctx('yes'), ownerWordsAt: new Date(clock.now().getTime() - 60_000) })).rejects.toThrow(/no message waiting/);
    expect(sent).toHaveLength(0);

    const c = (await j.tools.invoke('confirm_send', {}, ctx('yes, send it'))) as { sent: boolean; handlingReplies: boolean };
    expect(c).toMatchObject({ sent: true, handlingReplies: true });
    expect(sent.map((m) => m.message)).toEqual(['Hey Ana! Dinner on Sunday?']);
    expect(j.handoffs.list()[0]).toMatchObject({ status: 'active', contactName: 'Ana' });

    // Ana answers: Jennifer replies on her own, steered by the goal.
    clock.advance(60_000);
    await ana('Sure! What time?');
    await j.actions.runDue();
    expect(sent.map((m) => m.message)).toEqual(['Hey Ana! Dinner on Sunday?', 'Sunday at 8 works! See you then.']);
    expect(systems.at(-1)).toMatch(/His goal: agree a time for dinner on Sunday/);
    expect(inputs.at(-1)).toContain('Hey Ana! Dinner on Sunday?'); // she sees her own opener

    // Outside the goal ("is this a bot?"): it waits for Bruno.
    clock.advance(60_000);
    await ana('wait, is this a bot?');
    await j.actions.runDue();
    expect(sent).toHaveLength(2);
    const waiting = j.actions.list({ state: 'awaiting_decision' });
    expect(waiting).toHaveLength(1);

    // The debrief has the whole exchange and what needs him.
    const d = (await j.tools.invoke('get_debrief', {}, ctx('what did you do today?'))) as { sent: Array<{ authorizedBy: string }>; handled: Array<{ with: string; exchange: Array<{ who: string; text: string }> }>; needsYou: unknown[] };
    expect(d.sent.map((s) => s.authorizedBy)).toEqual(['you approved it', 'a conversation you handed me']);
    expect(d.handled[0]!.with).toBe('Ana');
    expect(d.handled[0]!.exchange.map((m) => `${m.who}: ${m.text}`)).toEqual(['you (Jennifer): Hey Ana! Dinner on Sunday?', 'Ana: Sure! What time?', 'you (Jennifer): Sunday at 8 works! See you then.', 'Ana: wait, is this a bot?']);
    expect(d.needsYou).toHaveLength(1);

    // Bruno types in the thread himself: Jennifer steps back and the permission is gone.
    await brunoTypes("Haha it's me, yes it's my assistant");
    expect(j.handoffs.list()[0]!.status).toBe('stopped');
    clock.advance(60_000);
    await ana('ok cool');
    await j.actions.runDue();
    expect(sent).toHaveLength(2);
  });

  it('asks instead of guessing, and hands the conversation back when time runs out', async () => {
    const { j, clock, ctx, ana, sent } = setup();
    const unknown = (await j.tools.invoke('message_someone', { who: 'my brother', message: 'Hi!', handle_replies: false }, ctx('text my brother hi'))) as { ok: boolean; question: string };
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown.question).toMatch(/don't know who "my brother" is/);

    await j.tools.invoke('save_contact', { name: 'Ana', phone: ANA, relation: 'sister' }, ctx('my sister is Ana +393409998888'));
    await j.tools.invoke('message_someone', { who: 'Ana', message: 'Hi Ana', handle_replies: true, hours: 2 }, ctx('text Ana hi and handle it'));
    clock.advance(3_000);
    await j.tools.invoke('confirm_send', {}, ctx('yes'));
    clock.advance(3 * 3600_000);
    await j.handoffs.tick();
    expect(j.handoffs.list()[0]!.status).toBe('expired');
    await ana('hey!');
    await j.actions.runDue();
    expect(sent).toHaveLength(1); // the reply now waits for Bruno
  });
});
