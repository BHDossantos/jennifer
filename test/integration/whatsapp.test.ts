import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createJennifer } from '../../src/app.js';
import { FakeClock } from '../../src/core/util.js';
import { ScriptedModel } from '../../src/core/model.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { buildServer } from '../../src/api/server.js';

const SECRET = 'meta-app-secret';

function setup() {
  const sent: any[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    expect(url).toBe('https://graph.facebook.com/v21.0/PNID1/messages');
    sent.push(JSON.parse(String(init!.body)));
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const clock = new FakeClock('2026-10-03T10:00:00Z');
  const j = createJennifer({
    clock,
    model: new ScriptedModel(() => JSON.stringify({ reply: 'Yes, we are open until 23:00 tonight.', cited_memory_ids: [], escalate: false, escalation_reason: '' })),
    emailConnectors: [new FakeEmailProvider()],
    fetchImpl,
    inventoryPath: null as never,
    config: { whatsapp: { token: 't', phoneNumberId: 'PNID1', appSecret: SECRET, verifyToken: 'verify-me-0123456789', graphVersion: 'v21.0', space: 'restaurant' } } as never,
  });
  j.contacts.add({ ownerId: 'bruno', displayName: 'Sara', spaces: ['restaurant'], identities: [{ kind: 'phone', value: '+393409998888', verified: true, source: 'bruno' }] });
  const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
  const post = (value: object, sign = true) => {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value }] }] });
    const sig = 'sha256=' + createHmac('sha256', sign ? SECRET : 'wrong').update(payload).digest('hex');
    return app.inject({ method: 'POST', url: '/v1/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, payload });
  };
  const incoming = (id: string, text: string) => ({ metadata: { phone_number_id: 'PNID1' }, contacts: [{ wa_id: '393409998888', profile: { name: 'Sara' } }], messages: [{ id, from: '393409998888', timestamp: String(clock.now().getTime() / 1000), type: 'text', text: { body: text } }] });
  return { j, app, post, incoming, sent, clock };
}

describe('WhatsApp Business (Cloud API, coexistence)', () => {
  it('verifies the webhook handshake and signatures', async () => {
    const { app, post, incoming } = setup();
    expect((await app.inject({ method: 'GET', url: '/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me-0123456789&hub.challenge=42' })).body).toBe('42');
    expect((await app.inject({ method: 'GET', url: '/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42' })).statusCode).toBe(403);
    expect((await post(incoming('w1', 'hi'), false)).statusCode).toBe(401);
  });

  it('a customer message gets a reply in Bruno\'s voice; with Autopilot it goes out in real time; delivery reconciles by key', async () => {
    const { j, post, incoming, sent } = setup();
    j.authority.grant({ principal: 'bruno', action: 'send_message', mode: 'execute', scope: { accountIds: ['whatsapp:PNID1'] }, limits: { maxRecipients: 3 }, note: 'template:autopilot' });
    expect((await post(incoming('w1', 'Are you open tonight?'))).statusCode).toBe(200);
    await j.actions.runDue();
    expect(sent).toEqual([expect.objectContaining({ messaging_product: 'whatsapp', to: '393409998888', type: 'text', text: { body: 'Yes, we are open until 23:00 tonight.', preview_url: false } })]);
    const [a] = j.actions.list({ ownerId: 'bruno' });
    expect(a).toMatchObject({ channel: 'whatsapp', connectorId: 'whatsapp_business', space: 'restaurant', state: 'provider_accepted' });
    expect(sent[0].biz_opaque_callback_data).toBe(a!.idempotencyKey);
  });

  it('outside the 24-hour window nothing free-form is sent; Bruno typing in the app cancels Jennifer\'s draft', async () => {
    const { j, post, incoming, sent, clock } = setup();
    await post(incoming('w1', 'Table for 4 tomorrow?'));
    const [draft] = j.actions.list({ state: 'awaiting_decision' });
    await post({ message_echoes: [{ id: 'e1', from: '15550000000', to: '393409998888', timestamp: String(clock.now().getTime() / 1000), type: 'text', text: { body: 'Sure Sara, booked!' } }] });
    expect(j.actions.get(draft!.id)).toMatchObject({ state: 'canceled', stateReason: 'Bruno replied manually' });

    await post(incoming('w2', 'Thanks!'));
    const [late] = j.actions.list({ state: 'awaiting_decision' });
    clock.advance(25 * 3600_000);
    j.actions.approve(late!.id, 'bruno', { revision: late!.revision, payloadHash: late!.payloadHash });
    await j.actions.runDue();
    expect(sent).toHaveLength(0);
    expect(j.actions.get(late!.id).state).toBe('failed');
  });
});
