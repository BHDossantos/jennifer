import { describe, expect, it } from 'vitest';
import { createJennifer } from '../../src/app.js';
import { buildServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/core/util.js';
import { ACCOUNT } from '../harness.js';
import type { PushSender } from '../../src/notify/push.js';

const SUB = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'BPk', auth: 'au' } };

function setup(at = '2026-10-05T10:00:00Z') {
  const clock = new FakeClock(at); // 12:00 in Rome
  const sent: Array<{ endpoint: string; payload: any; urgency: string }> = [];
  let failWith: number | undefined;
  const pushSender: PushSender = async (sub, payload, opts) => {
    if (failWith) throw Object.assign(new Error('gone'), { statusCode: failWith });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), urgency: opts.urgency });
    return { statusCode: 201 };
  };
  const j = createJennifer({ clock, pushSender, config: { ownerId: 'bruno' } });
  j.capabilities.markConnected('gmail', ACCOUNT);
  return { j, clock, sent, fail: (c?: number) => (failWith = c) };
}

const propose = (j: ReturnType<typeof setup>['j']) =>
  j.actions.propose({ ownerId: 'bruno', type: 'send_message', space: 'personal', channel: 'email', connectorId: 'gmail', accountId: ACCOUNT, payload: { to: ['someone@x.test'], cc: [], bcc: [], subject: 'Invoice 42', body: 'x', attachmentIds: [], evidence: [] }, proposedBy: 'jennifer' });

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('push notifications', () => {
  it('a waiting decision notifies once, without message details on the lock screen by default', async () => {
    const { j, sent } = setup();
    await j.notifications.subscribe(SUB, 'iPhone');
    const a = propose(j);
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ title: 'Jennifer needs a decision', body: 'A message is ready for your approval.', url: '/?tab=today' });
    expect(JSON.stringify(sent[0]!.payload)).not.toContain('Invoice 42');
    j.actions.requireDecision(a.id, 'jennifer', 'again'); // same revision → deduplicated
    await tick();
    expect(sent).toHaveLength(1);
    await j.notifications.setPrefs({ showDetails: true });
    propose(j);
    await tick();
    expect(sent[1]!.payload.body).toMatch(/Invoice 42/);
  });

  it('quiet hours hold non-urgent notices and send one morning summary; urgent problems go through', async () => {
    const { j, clock, sent } = setup('2026-10-05T21:30:00Z'); // 23:30 in Rome
    await j.notifications.subscribe(SUB);
    propose(j);
    propose(j);
    await tick();
    expect(sent).toHaveLength(0);
    j.capabilities.markDisconnected('gmail', 'invalid_grant');
    await tick();
    expect(sent.map((s) => s.payload.title)).toEqual(['Jennifer: an account disconnected']);
    expect(sent[0]!.urgency).toBe('high');
    clock.set('2026-10-06T05:45:00Z'); // 07:45 in Rome
    expect(await j.notifications.flushHeld()).toBe(2);
    expect(sent.at(-1)!.payload.body).toBe('2 decisions');
  });

  it('expired subscriptions are removed; API exposes key, subscribe and prefs', async () => {
    const { j, fail } = setup();
    const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
    const auth = { authorization: 'Bearer owner-token-0123456789' };
    const key = (await app.inject({ method: 'GET', url: '/v1/push/key', headers: auth })).json();
    expect(key.publicKey).toMatch(/^B[A-Za-z0-9_-]{80,}$/);
    expect((await app.inject({ method: 'POST', url: '/v1/push/subscribe', headers: auth, payload: { subscription: SUB, label: 'iPhone' } })).json()).toEqual({ subscribed: true });
    expect((await app.inject({ method: 'PUT', url: '/v1/notifications/prefs', headers: auth, payload: { quietStart: '23:00' } })).json().quietStart).toBe('23:00');
    fail(410);
    await app.inject({ method: 'POST', url: '/v1/push/test', headers: auth });
    expect(await j.notifications.subscriptions()).toHaveLength(0);
  });

  it('the service worker shows notifications and opens the right screen', async () => {
    const { SERVICE_WORKER } = await import('../../src/api/pwa.js');
    expect(SERVICE_WORKER).toMatch(/addEventListener\('push'/);
    expect(SERVICE_WORKER).toMatch(/notificationclick/);
    const { Script } = await import('node:vm');
    expect(() => new Script(SERVICE_WORKER)).not.toThrow();
  });
});
