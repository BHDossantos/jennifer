import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { InventorySchema, inventoryBlockers } from '../../src/setup/inventory.js';
import { enableTemplate } from '../../src/policy/templates.js';
import { ACCOUNT, makeHarness } from '../harness.js';

describe('Week 1 — inventory and operating contract', () => {
  it('the committed inventory parses and lists the remaining blockers', () => {
    const inv = InventorySchema.parse(JSON.parse(readFileSync('config/inventory.json', 'utf8')));
    expect(inv.phone).toMatchObject({ model: 'iPhone 17 Pro Max', os: 'iOS', carrier: 'AT&T' });
    const missing = inventoryBlockers(inv).map((b) => b.missing);
    expect(inv.phone.osVersion).toBe('26.6.1');
    expect(missing).toEqual(expect.arrayContaining([expect.stringMatching(/Phone number/), expect.stringMatching(/Apple Developer Program/)]));
    expect(missing.some((m) => /iOS version|Email accounts/.test(m))).toBe(false);
    expect(missing.some((m) => /browser-assistant/.test(m))).toBe(false);
  });

  it('templates must be scoped and create ordinary, revocable rules', async () => {
    const h = makeHarness();
    expect(() => enableTemplate(h.j.authority, 'routine_scheduling', 'bruno', {})).toThrow(/scoped/);
    const rules = enableTemplate(h.j.authority, 'routine_scheduling', 'bruno', { contactIds: [h.contacts.marco] });
    expect(rules.map((r) => r.action)).toEqual(['create_event', 'modify_event', 'send_message']);
    const send = h.j.actions.propose({ ownerId: 'bruno', type: 'send_message', space: 'music', channel: 'email', connectorId: 'gmail', accountId: ACCOUNT, payload: h.sendPayload({ to: ['marco@bianchi-music.it'], body: 'Thursday 16:00 works.' }), proposedBy: 'jennifer' });
    expect(send.state).toBe('ready');
    const tooMany = h.j.actions.propose({ ownerId: 'bruno', type: 'send_message', space: 'music', channel: 'email', connectorId: 'gmail', accountId: ACCOUNT, payload: h.sendPayload({ to: ['marco@bianchi-music.it'], cc: ['giulia@trattoria.it', 'anna.r87@gmail.com', 'anna.rossi@assicura.it'], body: 'All of you' }), proposedBy: 'jennifer' });
    expect(tooMany.state).toBe('awaiting_decision');
    for (const r of rules) h.j.authority.revoke(r.id, 'bruno');
    expect(h.j.actions.get(send.id).state).toBe('awaiting_decision');
  });

  it('the capability screen is honest about iPhone messaging', () => {
    const h = makeHarness();
    const imessage = h.j.capabilities.screen().find((c) => c.id === 'imessage')!;
    expect(imessage.canMonitor).toBe(false);
    expect(imessage.unavailable).toEqual(expect.arrayContaining(['read', 'send']));
    expect(imessage.problem).toMatch(/no access to the Messages inbox/);
    expect(h.j.capabilities.get('telephony')!.reconnectProcedure).toMatch(/\*\*61\*/);
  });
});
