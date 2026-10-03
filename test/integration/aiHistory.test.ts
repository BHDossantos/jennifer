import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { createDurableJennifer, createJennifer } from '../../src/app.js';
import { pgliteDb } from '../../src/db/db.js';
import { FakeClock } from '../../src/core/util.js';
import { ScriptedModel } from '../../src/core/model.js';
import { FakeEmailProvider } from '../../src/connectors/fakeEmail.js';
import { parseAiExport } from '../../src/memory/aiHistory.js';
import { buildServer } from '../../src/api/server.js';

const chatgpt = JSON.stringify([
  {
    id: 'cg-1',
    title: 'Insurance agency plan',
    create_time: 1760000000,
    update_time: 1760000500,
    current_node: 'm3',
    mapping: {
      root: { parent: null, message: null },
      m1: { parent: 'root', message: { id: 'm1', author: { role: 'user' }, create_time: 1760000000, content: { content_type: 'text', parts: ['I want to open my own insurance agency in Milan by spring 2027.'] } } },
      m2: { parent: 'm1', message: { id: 'm2', author: { role: 'assistant' }, create_time: 1760000100, content: { content_type: 'text', parts: ['Here is a plan for the IVASS registration...'] } } },
      alt: { parent: 'm1', message: { id: 'alt', author: { role: 'assistant' }, create_time: 1760000050, content: { content_type: 'text', parts: ['abandoned branch'] } } },
      m3: { parent: 'm2', message: { id: 'm3', author: { role: 'user' }, create_time: 1760000200, content: { content_type: 'text', parts: ['Always write to carriers in Italian.'] } } },
    },
  },
]);

const claudeConvs = JSON.stringify([
  {
    uuid: 'cl-1',
    name: 'Album release',
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-02T10:00:00Z',
    project_uuid: 'p-1',
    chat_messages: [
      { uuid: 'a', sender: 'human', text: 'My next single "Notte" comes out on November 14.', created_at: '2026-09-01T10:00:00Z' },
      { uuid: 'b', sender: 'assistant', text: '', content: [{ type: 'text', text: 'Great — let us plan the outreach to radio stations.' }], created_at: '2026-09-01T10:01:00Z' },
    ],
  },
]);
const claudeProjects = JSON.stringify([{ uuid: 'p-1', name: 'Music career', description: 'Releases and outreach', prompt_template: 'Be direct.', docs: [{ filename: 'press-kit.md', content: 'Bio: Bruno...' }] }]);

describe('ChatGPT and Claude history bridge', () => {
  it('parses both export formats, following the active ChatGPT branch and Claude projects', () => {
    const cg = parseAiExport({ json: chatgpt });
    expect(cg.source).toBe('chatgpt');
    expect(cg.conversations[0]!.messages.map((m) => m.text)).toEqual(['I want to open my own insurance agency in Milan by spring 2027.', 'Here is a plan for the IVASS registration...', 'Always write to carriers in Italian.']);
    const zip = zipSync({ 'data/conversations.json': strToU8(claudeConvs), 'data/projects.json': strToU8(claudeProjects), 'users.json': strToU8('[]') });
    const cl = parseAiExport({ zip });
    expect(cl.source).toBe('claude');
    expect(cl.conversations[0]).toMatchObject({ title: 'Album release', project: 'Music career' });
    expect(cl.conversations[0]!.messages[1]!.text).toMatch(/radio stations/);
    expect(cl.projects[0]).toMatchObject({ name: 'Music career', instructions: 'Be direct.' });
    expect(() => parseAiExport({ json: '[{"foo":1}]' })).toThrow(/ChatGPT or Claude/);
  });

  it('imports durably, deduplicates re-imports, searches, and suggests memories only for review', async () => {
    const db = await pgliteDb();
    const clock = new FakeClock('2026-10-03T08:00:00Z');
    const model = new ScriptedModel(() =>
      JSON.stringify({
        facts: [
          { kind: 'instruction', value: 'Write to insurance carriers in Italian', quote: 'Always write to carriers in Italian.' },
          { kind: 'profile_fact', value: 'Bruno owns a yacht', quote: 'I own a yacht' }, // not in his words → dropped
        ],
      }),
    );
    const j = await createDurableJennifer({ db, clock, model, emailConnectors: [new FakeEmailProvider()], config: { ownerId: 'bruno' } });
    const first = await j.history.importExport({ json: chatgpt }, 'bruno');
    expect(first).toMatchObject({ source: 'chatgpt', conversations: 1, messages: 3 });
    expect((await j.history.importExport({ json: chatgpt }, 'bruno')).id).toBe(first.id); // same file
    const zip = zipSync({ 'conversations.json': strToU8(claudeConvs), 'projects.json': strToU8(claudeProjects) });
    expect(await j.history.importExport({ zip }, 'bruno')).toMatchObject({ source: 'claude', conversations: 1, projects: 1 });

    const hits = await j.history.search('insurance agency Milan');
    expect(hits[0]).toMatchObject({ conversationId: 'chatgpt:cg-1', source: 'chatgpt' });
    expect(await j.history.search('Notte single', { source: 'claude' })).toHaveLength(1);
    expect((await j.history.projects())[0]!.docs[0]!.filename).toBe('press-kit.md');

    const proposed = await j.history.proposeMemories('chatgpt:cg-1', 'insurance', 'bruno');
    expect(proposed.map((m) => m.value)).toEqual(['Write to insurance carriers in Italian']);
    expect(proposed[0]!.status).toBe('pending_review');
    expect(j.memory.retrieve({ ownerId: 'bruno', text: 'carriers Italian', spaces: ['insurance'], maxSensitivity: 'normal' })).toHaveLength(0);

    // The tool the chat and missions use; results are marked as imported history.
    const viaTool = (await j.tools.invoke('search_ai_history', { query: 'radio outreach' }, { ownerId: 'bruno', role: 'chat', allowedTools: new Set(['search_ai_history']), scopes: new Set(['history:read']) })) as Array<{ title: string }>;
    expect(viaTool[0]!.title).toBe('Album release');

    await j.history.deleteImport(first.id, 'bruno');
    expect(await j.history.search('insurance agency')).toHaveLength(0);
    await j.store.flush();
    await db.close();
  });

  it('Send to Jennifer: a shared conversation becomes searchable; the API requires the owner', async () => {
    const j = createJennifer({ clock: new FakeClock('2026-10-03T08:00:00Z'), emailConnectors: [new FakeEmailProvider()], inventoryPath: null as never });
    const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
    const auth = { authorization: 'Bearer owner-token-0123456789' };
    expect((await app.inject({ method: 'POST', url: '/v1/history/clip', payload: { text: 'x' } })).statusCode).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/v1/history/clip', headers: auth, payload: { text: 'Claude helped me compare the Generali and Allianz agency contracts. Generali pays 12% commission.', from: 'claude' } });
    expect(r.statusCode).toBe(200);
    const s = (await app.inject({ method: 'GET', url: '/v1/history/search?q=Generali%20commission', headers: auth })).json();
    expect(s[0].excerpt).toMatch(/12% commission/);
    const zip = zipSync({ 'conversations.json': strToU8(chatgpt) });
    const up = await app.inject({ method: 'POST', url: '/v1/history/import-zip', headers: { ...auth, 'content-type': 'application/zip' }, payload: Buffer.from(zip) });
    expect(up.json()).toMatchObject({ source: 'chatgpt', messages: 3 });
  });
});
