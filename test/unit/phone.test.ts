import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createJennifer } from '../../src/app.js';
import { buildServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/core/util.js';
import { extractNumber, signStandardWebhook, type SidebandSocket } from '../../src/voice/phone.js';

const SECRET = 'whsec_' + Buffer.from('phone-webhook-secret-0123456789').toString('base64');
const OWNER = { authorization: 'Bearer owner-token-0123456789' };

class FakeSocket extends EventEmitter implements SidebandSocket {
  sent: any[] = [];
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.emit('close');
  }
}

function setup(opts: { transfer?: string; referFails?: boolean } = {}) {
  const clock = new FakeClock(new Date());
  const api: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    api.push({ url, body: JSON.parse(String(init.body)) });
    if (opts.referFails && url.endsWith('/refer')) return new Response('busy', { status: 500 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  let socket: FakeSocket | undefined;
  const pushes: any[] = [];
  const j = createJennifer({
    clock,
    fetchImpl,
    openSideband: () => (socket = new FakeSocket()),
    pushSender: async (_s, payload) => (pushes.push(JSON.parse(payload)), { statusCode: 201 }),
    config: { ownerId: 'bruno', transferNumber: opts.transfer, openai: { apiKey: 'sk-test-abcdefghijklmnopqrstuvwxyz', webhookSecret: SECRET } as never },
  });
  j.contacts.add({ ownerId: 'bruno', displayName: 'Marco Bianchi', spaces: ['music'], identities: [{ kind: 'phone', value: '+390612345678', verified: true, source: 't' }] });
  const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
  const incoming = (callId = 'rtc_123', from = '+390612345678') => {
    const body = JSON.stringify({ id: 'evt_1', type: 'realtime.call.incoming', created_at: Math.floor(Date.now() / 1000), data: { call_id: callId, sip_headers: [{ name: 'From', value: `"Marco" <sip:${from}@pstn.test>;tag=abc` }, { name: 'To', value: '<sip:+19785550100@sip.api.openai.com>' }] } });
    const ts = String(Math.floor(clock.now().getTime() / 1000));
    return app.inject({ method: 'POST', url: '/v1/webhooks/openai', headers: { 'content-type': 'application/json', 'webhook-id': 'wh_1', 'webhook-timestamp': ts, 'webhook-signature': signStandardWebhook(body, 'wh_1', ts, SECRET) }, payload: body });
  };
  const toolCall = async (name: string, args: object, id = `call_${name}`) => {
    socket!.emit('message', JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) } }));
    await new Promise((r) => setTimeout(r, 20));
  };
  return { j, app, api, incoming, toolCall, socket: () => socket!, pushes };
}

describe('phone calls (OpenAI Realtime SIP)', () => {
  it('rejects unsigned webhooks and answers signed ones with the business persona', async () => {
    const t = setup();
    const bad = await t.app.inject({ method: 'POST', url: '/v1/webhooks/openai', headers: { 'content-type': 'application/json', 'webhook-id': 'x', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,AAAA' }, payload: '{}' });
    expect(bad.statusCode).toBe(401);
    const r = await t.incoming();
    expect(r.json()).toMatchObject({ handled: true, action: 'accepted' });
    const accept = t.api.find((c) => c.url.endsWith('/realtime/calls/rtc_123/accept'))!;
    expect(accept.body.audio.output.voice).toBe('marin');
    expect(accept.body.instructions).toMatch(/Business mode/);
    expect(accept.body.instructions).toMatch(/Caller ID suggests Marco Bianchi, but this is NOT verified/);
    expect(accept.body.instructions).not.toMatch(/Private mode|allure/);
    expect(accept.body.tools.map((x: { name: string }) => x.name)).toEqual(['take_message', 'check_availability', 'transfer_to_bruno', 'end_call']);
  });

  it('takes a message, notifies Bruno, and never promises a callback', async () => {
    const t = setup();
    await t.j.notifications.subscribe({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'p', auth: 'a' } });
    await t.incoming();
    await t.toolCall('take_message', { name: 'Laura', callback_number: '+15550001', message: 'Please confirm the 12 November gig', urgent: true });
    const out = t.socket().sent.find((m) => m.type === 'conversation.item.create')!;
    expect(JSON.parse(out.item.output)).toMatchObject({ saved: true });
    expect(t.socket().sent.at(-1)).toEqual({ type: 'response.create' });
    expect(t.pushes[0]).toMatchObject({ title: 'Urgent call message' });
    const calls = (await t.app.inject({ method: 'GET', url: '/v1/calls', headers: OWNER })).json().calls;
    expect(calls[0].messages[0]).toMatchObject({ name: 'Laura', text: 'Please confirm the 12 November gig', urgent: true });
  });

  it('availability reveals free times only; transfer falls back to message-taking', async () => {
    const t = setup({ transfer: '+15557654321', referFails: true });
    await t.incoming();
    const ev = t.j.calendar.buildEvent({ calendarId: 'primary', title: 'Doctor appointment', start: { date: '2026-12-01', time: '10:00', timeZone: 'Europe/Rome' }, durationMin: 60, attendees: [] });
    await t.j.calendar.provider.upsert(ev);
    await t.toolCall('check_availability', { date: '2026-12-01', duration_min: 60 });
    const avail = JSON.parse(t.socket().sent.find((m) => m.item?.call_id === 'call_check_availability').item.output);
    expect(avail.free).not.toContain('10:00');
    expect(JSON.stringify(avail)).not.toMatch(/Doctor/);
    await t.toolCall('transfer_to_bruno', { reason: 'family emergency' });
    const tr = JSON.parse(t.socket().sent.find((m) => m.item?.call_id === 'call_transfer_to_bruno').item.output);
    expect(tr).toMatchObject({ transferred: false });
    expect(t.api.some((c) => c.url.endsWith('/refer') && c.body.target_uri === 'tel:+15557654321')).toBe(true);
    t.socket().close();
    await new Promise((r) => setTimeout(r, 20));
    const calls = (await t.app.inject({ method: 'GET', url: '/v1/calls', headers: OWNER })).json().calls;
    expect(calls[0]).toMatchObject({ outcome: 'transfer_failed' });
    expect(calls[0].endedAt).toBeDefined();
  });

  it('parses caller numbers from SIP headers', () => {
    expect(extractNumber('"Marco" <sip:+390612345678@pstn.test>;tag=1')).toBe('+390612345678');
    expect(extractNumber('<tel:15551234567>')).toBe('+15551234567');
    expect(extractNumber('anonymous')).toBeUndefined();
  });
});
