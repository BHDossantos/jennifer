import { describe, expect, it } from 'vitest';
import { createJennifer } from '../../src/app.js';
import { FakeClock } from '../../src/core/util.js';
import { ScriptedModel } from '../../src/core/model.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { buildServer } from '../../src/api/server.js';

const TOKEN = 'imessage-webhook-token-0123456789';

function fakeMac() {
  const sent: any[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    expect(u.searchParams.get('password')).toBe('mac-pass');
    if (init?.method === 'POST' && u.pathname.endsWith('/message/text')) {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ status: 200, data: { guid: `p:${sent.length}` } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

function setup() {
  const mac = fakeMac();
  const model = new ScriptedModel(() => JSON.stringify({ reply: 'Sounds good, see you at 8!', cited_memory_ids: [], escalate: false, escalation_reason: '' }));
  const j = createJennifer({
    clock: new FakeClock('2026-10-03T18:00:00Z'),
    model,
    emailConnectors: [new FakeEmailProvider()],
    fetchImpl: mac.fetchImpl,
    inventoryPath: null as never,
    config: { imessage: { url: 'https://bruno-mac.example', password: 'mac-pass', webhookToken: TOKEN, method: 'apple-script' } } as never,
  });
  j.contacts.add({ ownerId: 'bruno', displayName: 'Luca', spaces: ['personal'], identities: [{ kind: 'phone', value: '+393401112222', verified: true, source: 'bruno' }] });
  const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
  const hook = (data: object, token = TOKEN) => app.inject({ method: 'POST', url: `/v1/webhooks/imessage?token=${token}`, payload: { type: 'new-message', data } });
  const msg = (p: Partial<{ guid: string; text: string; isFromMe: boolean; chat: string; from: string }>) => ({
    guid: p.guid ?? 'g1',
    text: p.text ?? 'Dinner tonight at 8?',
    isFromMe: p.isFromMe ?? false,
    dateCreated: Date.parse('2026-10-03T18:00:00Z'),
    handle: p.isFromMe ? null : { address: p.from ?? '+393401112222' },
    chats: [{ guid: p.chat ?? 'iMessage;-;+393401112222' }],
  });
  return { j, mac, hook, msg };
}

describe('iMessage via BlueBubbles on Bruno\'s Mac', () => {
  it('rejects a bad token; a new iMessage gets a reply in Bruno\'s voice that waits for him, then goes out through the Mac', async () => {
    const { j, mac, hook, msg } = setup();
    expect((await hook(msg({}), 'wrong-token-wrong-token-wrong')).statusCode).toBe(401);
    expect((await hook(msg({}))).json()).toMatchObject({ received: true, drafted: true });
    const [draft] = j.actions.list({ state: 'awaiting_decision' });
    expect(draft).toMatchObject({ channel: 'imessage', connectorId: 'imessage' });
    j.actions.approve(draft!.id, 'bruno', { revision: draft!.revision, payloadHash: draft!.payloadHash });
    await j.actions.runDue();
    expect(j.actions.get(draft!.id).state).toBe('provider_accepted');
    expect(mac.sent).toEqual([expect.objectContaining({ chatGuid: 'iMessage;-;+393401112222', message: 'Sounds good, see you at 8!', method: 'apple-script' })]);
    // The Mac echoes Jennifer's send back: not mistaken for Bruno typing.
    expect((await hook(msg({ guid: 'g2', isFromMe: true, text: 'Sounds good, see you at 8!' }))).json()).toEqual({ own: true });
  });

  it('when Bruno answers from his phone, Jennifer cancels her pending reply; group chats are context only', async () => {
    const { j, hook, msg } = setup();
    await hook(msg({}));
    const [draft] = j.actions.list({ state: 'awaiting_decision' });
    await hook(msg({ guid: 'g3', isFromMe: true, text: 'Yes! 8 works' }));
    expect(j.actions.get(draft!.id)).toMatchObject({ state: 'canceled', stateReason: 'Bruno replied manually' });
    expect((await hook(msg({ guid: 'g4', chat: 'iMessage;+;chat99', text: 'Who is coming Saturday?' }))).json()).toMatchObject({ drafted: false });
  });
});
