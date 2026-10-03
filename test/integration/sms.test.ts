import { describe, expect, it } from 'vitest';
import { createJennifer } from '../../src/app.js';
import { FakeClock } from '../../src/core/util.js';
import { ScriptedModel } from '../../src/core/model.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { TwilioSms, twilioSignature } from '../../src/connectors/sms/twilio.js';
import { buildServer } from '../../src/api/server.js';

const TOKEN = 'twilio-auth-token';
const PUBLIC = 'https://jennifer.example.com';

function fakeTwilio() {
  const sent: Array<Record<string, string>> = [];
  let failNext = false;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const p = Object.fromEntries(new URLSearchParams(String(init.body)));
      sent.push(p);
      if (failNext) {
        failNext = false;
        throw new Error('socket hang up'); // the provider may have accepted it
      }
      return new Response(JSON.stringify({ sid: `SM${sent.length}`, status: 'queued' }), { status: 201 });
    }
    // GET list for reconciliation
    return new Response(JSON.stringify({ messages: sent.map((m, i) => ({ sid: `SM${i + 1}`, body: m.Body, date_created: new Date().toISOString() })) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, failOnce: () => (failNext = true) };
}

function setup() {
  const tw = fakeTwilio();
  const model = new ScriptedModel(() => JSON.stringify({ reply: 'Hi Anna, Bruno is in a meeting; he will call you after 5pm.', cited_memory_ids: [], escalate: false, escalation_reason: '' }));
  const j = createJennifer({
    clock: new FakeClock('2026-10-03T08:00:00Z'),
    model,
    emailConnectors: [new FakeEmailProvider()],
    fetchImpl: tw.fetchImpl,
    inventoryPath: null as never,
    config: { sms: { accountSid: 'AC123', authToken: TOKEN, from: '+15550001111', alertTo: '+15550002222' }, publicUrl: PUBLIC } as never,
  });
  const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
  return { j, app, tw };
}

const form = (p: Record<string, string>) => new URLSearchParams(p).toString();

describe('SMS on Jennifer\'s number', () => {
  it('signed texts become a conversation with a drafted SMS reply that waits for Bruno; bad signatures are refused', async () => {
    const { j, app } = setup();
    const params = { MessageSid: 'SMin1', From: '+393331234567', To: '+15550001111', Body: 'Is Bruno free today?' };
    const bad = await app.inject({ method: 'POST', url: '/v1/webhooks/sms', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'nope' }, payload: form(params) });
    expect(bad.statusCode).toBe(401);
    const sig = twilioSignature(TOKEN, `${PUBLIC}/v1/webhooks/sms`, params);
    const ok = await app.inject({ method: 'POST', url: '/v1/webhooks/sms', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, payload: form(params) });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toMatch(/<Response>/);
    const [conv] = j.conversations.listConversations('bruno');
    expect(conv).toMatchObject({ channel: 'sms' });
    const [draft] = j.actions.list({ state: 'awaiting_decision' });
    expect(draft).toMatchObject({ channel: 'sms', connectorId: 'sms' });
    expect((draft!.payload as { to: string[]; subject?: string }).to).toEqual(['+393331234567']);
    expect((draft!.payload as { subject?: string }).subject).toBeUndefined();
  });

  it('approved SMS is sent once; a dropped connection is reconciled instead of resent', async () => {
    const { j, tw } = setup();
    const a = j.actions.propose({ ownerId: 'bruno', type: 'send_message', space: 'personal', channel: 'sms', connectorId: 'sms', accountId: 'sms:+15550001111', payload: { to: ['+393331234567'], cc: [], bcc: [], body: 'On my way', attachmentIds: [], evidence: [] }, proposedBy: 'test' });
    tw.failOnce();
    j.actions.approve(a.id, 'bruno', { revision: a.revision, payloadHash: a.payloadHash });
    await j.actions.execute(a.id);
    expect(j.actions.get(a.id).state).toBe('unknown');
    await j.actions.recoverUnknown();
    expect(j.actions.get(a.id).state).toBe('provider_accepted');
    expect(tw.sent.filter((m) => m.Body === 'On my way')).toHaveLength(1);
  });

  it('urgent alerts fall back to SMS on Bruno\'s phone when push is unavailable', async () => {
    const { j, tw } = setup();
    expect(await j.notifications.notify({ kind: 'problem', title: 'Account disconnected', body: 'Gmail needs reconnecting', url: '/', urgent: true, dedupKey: 'x' })).toBe('sent');
    expect(tw.sent.at(-1)).toMatchObject({ To: '+15550002222', From: '+15550001111' });
    expect(await j.notifications.notify({ kind: 'mission', title: 'Not urgent', body: 'x', url: '/', dedupKey: 'y' })).toBe('no_devices');
  });

  it('rejects malformed numbers and attachments without calling the provider', async () => {
    const tw = fakeTwilio();
    const s = new TwilioSms({ accountSid: 'AC1', authToken: 't', from: '+15550001111', fetchImpl: tw.fetchImpl });
    expect(await s.send({ accountId: 'a', conversationId: 'c', to: ['333-123'], cc: [], bcc: [], body: 'x', attachments: [], idempotencyKey: 'k1' })).toMatchObject({ kind: 'rejected' });
    expect(tw.sent).toHaveLength(0);
  });
});
