import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDurableJennifer } from '../../src/app.js';
import { pgliteDb, type Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';
import { FakeClock } from '../../src/core/util.js';
import { ScriptedModel } from '../../src/core/model.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import type { MessagingConnector, OutboundMessage, SendResult } from '../../src/connectors/connector.js';
import type { InboundEmail } from '../../src/assistant/inbound.js';

const ACCOUNT = 'bruno@gmail.test';

async function boot(db: Db, gmail: MessagingConnector, clock = new FakeClock('2026-10-26T08:00:00Z')) {
  const model = new ScriptedModel(() => JSON.stringify({ reply: 'Thursday works.', cited_memory_ids: [], escalate: false, escalation_reason: '' }));
  const j = await createDurableJennifer({ db, clock, model, emailConnectors: [gmail], random: () => 0.5, config: { ownerId: 'bruno' } });
  j.capabilities.markConnected('gmail', ACCOUNT);
  return j;
}

async function seed(j: Awaited<ReturnType<typeof boot>>) {
  const marco = j.contacts.add({ ownerId: 'bruno', displayName: 'Marco Bianchi', spaces: ['music'], identities: [{ kind: 'email', value: 'marco@bianchi-music.it', verified: true, source: 'test' }] });
  j.authority.grant({ principal: 'bruno', action: 'send_message', mode: 'execute', scope: { accountIds: [ACCOUNT], contactIds: [marco.id] } });
  await j.store.flush();
  return marco;
}

const email = (id: string): InboundEmail => ({
  accountId: ACCOUNT,
  connectorId: 'gmail',
  providerMessageId: id,
  providerThreadId: `t-${id}`,
  from: { displayName: 'Marco Bianchi', address: 'marco@bianchi-music.it' },
  to: [ACCOUNT],
  cc: [],
  subject: 'Thursday?',
  body: 'Can we do Thursday?',
  headers: {},
  occurredAt: new Date('2026-10-26T07:59:00Z'),
  space: 'music',
});

describe('Week 2 — durable foundation (Postgres via PGlite)', () => {
  it('migrations are ordered, idempotent and refuse edited history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    cpSync('db/migrations', dir, { recursive: true });
    const db = await pgliteDb();
    expect((await migrate(db, dir)).applied).toEqual(['0001_init.sql', '0002_event_lease_and_sessions.sql', '0003_connector_cursor.sql']);
    expect((await migrate(db, dir)).applied).toEqual([]);
    writeFileSync(join(dir, '0002_event_lease_and_sessions.sql'), '-- tampered');
    await expect(migrate(db, dir)).rejects.toThrow(/changed after it was applied/);
    await db.close();
  });

  it('synthetic replay across a restart cannot duplicate actions', async () => {
    const db = await pgliteDb();
    const gmail = new FakeEmailProvider('gmail');
    const j1 = await boot(db, gmail);
    await seed(j1);
    const events = ['r1', 'r2', 'r3'].map(email);
    for (const e of [...events, ...events]) await j1.inbound.handle(e, { autoDraft: true });
    await j1.actions.runDue();
    await j1.store.flush();
    expect(gmail.sent).toHaveLength(3);

    // "Restart": a fresh process on the same database replays the whole log.
    const j2 = await boot(db, gmail);
    expect(j2.authority.list()).toHaveLength(1);
    expect(j2.contacts.list('bruno')).toHaveLength(1);
    expect(j2.actions.list({ state: 'provider_accepted' })).toHaveLength(3);
    for (const e of events) expect((await j2.inbound.handle(e, { autoDraft: true })).duplicate).toBe(true);
    await j2.actions.runDue();
    expect(gmail.sent).toHaveLength(3);

    const audit = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_event WHERE kind = 'action.executed'");
    expect(audit.rows[0]!.n).toBe(3);
    await db.close();
  });

  it('a crash mid-send is recovered as unknown and reconciled, not resent', async () => {
    const db = await pgliteDb();
    const backing = new FakeEmailProvider('gmail');
    // Provider accepts the message, then the process "dies" before seeing the response.
    const hanging: MessagingConnector = {
      id: 'gmail',
      send: (msg: OutboundMessage): Promise<SendResult> => {
        void backing.send(msg);
        return new Promise<SendResult>(() => {});
      },
      findByIdempotencyKey: (a, k) => backing.findByIdempotencyKey(a, k),
    };
    const j1 = await boot(db, hanging);
    await seed(j1);
    const out = await j1.inbound.handle(email('crash-1'), { autoDraft: true });
    void j1.actions.execute(out.proposedActionId!);
    await new Promise((r) => setTimeout(r, 50));
    const row = await db.query<{ state: string }>('SELECT state FROM action_intent WHERE id = $1', [out.proposedActionId]);
    expect(row.rows[0]!.state).toBe('executing'); // write-ahead before the provider call

    const j2 = await boot(db, backing);
    expect(j2.actions.get(out.proposedActionId!).state).toBe('unknown');
    await j2.actions.recoverUnknown();
    expect(j2.actions.get(out.proposedActionId!).state).toBe('provider_accepted');
    await j2.actions.runDue();
    expect(backing.sent).toHaveLength(1);
    await j2.store.flush();
    await db.close();
  });

  it('revocation persists across restarts', async () => {
    const db = await pgliteDb();
    const gmail = new FakeEmailProvider('gmail');
    const j1 = await boot(db, gmail);
    await seed(j1);
    const rule = j1.authority.list()[0]!;
    j1.authority.revoke(rule.id, 'bruno');
    await j1.store.flush();
    const j2 = await boot(db, gmail);
    const out = await j2.inbound.handle(email('after-revoke'), { autoDraft: true });
    expect(j2.actions.get(out.proposedActionId!).state).toBe('awaiting_decision');
    await j2.actions.runDue();
    expect(gmail.sent).toHaveLength(0);
    await j2.store.flush();
    await db.close();
  });
});
