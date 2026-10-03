import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { createJennifer } from '../../src/app.js';
import { buildServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/core/util.js';

const OWNER = 'owner-token-0123456789';
const API_KEY = 'sk-test-SECRET-abcdefghijklmnopqrstuv';

function fakeOpenAI() {
  const calls: Array<{ url: string; body: any; auth: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) });
    if (url.endsWith('/realtime/client_secrets')) return new Response(JSON.stringify({ value: 'ek_ephemeral_123', expires_at: 1791100000, session: {} }), { status: 200 });
    if (url.endsWith('/audio/speech')) return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function setup() {
  const oa = fakeOpenAI();
  const j = createJennifer({ clock: new FakeClock(), fetchImpl: oa.fetchImpl, config: { ownerId: 'bruno', openai: { apiKey: API_KEY } as never } });
  const app = buildServer(j, { tokens: { [OWNER]: 'owner' } });
  const auth = { authorization: `Bearer ${OWNER}` };
  return { j, app, auth, oa };
}

describe('Jennifer voice', () => {
  it('offers four female voices and defaults to Marin in private mode', async () => {
    const { app, auth } = setup();
    const v = (await app.inject({ method: 'GET', url: '/v1/voice', headers: auth })).json();
    expect(v.candidates.map((c: { id: string }) => c.id)).toEqual(['marin', 'shimmer', 'coral', 'sage']);
    expect(v.settings).toMatchObject({ voiceId: 'marin', mode: 'private' });
  });

  it('mints an ephemeral session: chosen voice, persona and tools; the API key never reaches the client', async () => {
    const { app, auth, oa } = setup();
    await app.inject({ method: 'PUT', url: '/v1/voice/settings', headers: auth, payload: { voiceId: 'shimmer', warmth: 0.9 } });
    const res = await app.inject({ method: 'POST', url: '/v1/voice/session', headers: auth, payload: { language: 'pt-BR' } });
    const s = res.json();
    expect(s.clientSecret).toBe('ek_ephemeral_123');
    expect(res.body).not.toContain(API_KEY);
    const call = oa.calls.find((c) => c.url.endsWith('/realtime/client_secrets'))!;
    expect(call.auth).toBe(`Bearer ${API_KEY}`);
    expect(call.body.session.audio.output.voice).toBe('shimmer');
    expect(call.body.session.instructions).toMatch(/Private mode with Bruno/);
    expect(call.body.session.instructions).toMatch(/Bom dia, Bruno/);
    expect(call.body.expires_after.seconds).toBe(600);
    const toolNames = call.body.session.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(['get_today_brief', 'list_pending_decisions', 'create_draft']));
    expect(toolNames).not.toContain('send_message'); // voice can draft, never send directly
    expect(call.body.session.tools[0].parameters.$schema).toBeUndefined();
  });

  it('business mode never carries the private persona', async () => {
    const { app, auth, oa } = setup();
    await app.inject({ method: 'POST', url: '/v1/voice/session', headers: auth, payload: { mode: 'business' } });
    const body = oa.calls.at(-1)!.body;
    expect(body.session.instructions).toMatch(/Business mode/);
    expect(body.session.instructions).not.toMatch(/allure|Private mode/);
  });

  it('auditions return audio, are cached, and reject unknown voices', async () => {
    const { app, auth, oa } = setup();
    const a = await app.inject({ method: 'GET', url: '/v1/voice/audition?voice=marin&mode=private', headers: auth });
    expect(a.headers['content-type']).toBe('audio/mpeg');
    expect(a.rawPayload.subarray(0, 3).toString()).toBe('ID3');
    await app.inject({ method: 'GET', url: '/v1/voice/audition?voice=marin&mode=private', headers: auth });
    expect(oa.calls.filter((c) => c.url.endsWith('/audio/speech'))).toHaveLength(1);
    expect(oa.calls[0]!.body.instructions).toMatch(/warm/i);
    expect((await app.inject({ method: 'GET', url: '/v1/voice/audition?voice=onyx', headers: auth })).statusCode).toBe(409);
  });

  it('voice tool calls run through the registry with the voice allowlist', async () => {
    const { app, auth } = setup();
    const brief = (await app.inject({ method: 'POST', url: '/v1/voice/tools/get_today_brief', headers: auth, payload: { arguments: '{}' } })).json();
    expect(brief.ok).toBe(true);
    expect(brief.result).toMatch(/connectorHealth/);
    expect(brief.result).toMatch(/^<untrusted-/); // third-party text is labeled for the realtime model
    const send = (await app.inject({ method: 'POST', url: '/v1/voice/tools/send_message', headers: auth, payload: { arguments: { to: ['x@y.z'], body: 'hi' } } })).json();
    expect(send).toMatchObject({ ok: false });
    expect((await app.inject({ method: 'POST', url: '/v1/voice/tools/get_today_brief', payload: {} })).statusCode).toBe(401);
  });

  it('serves an installable app shell with valid PNG icons', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/manifest.webmanifest' })).json()).toMatchObject({ display: 'standalone', start_url: '/' });
    expect((await app.inject({ method: 'GET', url: '/sw.js' })).body).toMatch(/startsWith\('\/v1\/'\)/);
    const icon = (await app.inject({ method: 'GET', url: '/apple-touch-icon.png' })).rawPayload;
    expect(icon.subarray(1, 4).toString()).toBe('PNG');
    expect(icon.readUInt32BE(16)).toBe(180);
    const idat = icon.indexOf('IDAT');
    expect(inflateSync(icon.subarray(idat + 4, idat + 4 + icon.readUInt32BE(idat - 4))).length).toBe((180 * 4 + 1) * 180);
    const html = (await app.inject({ method: 'GET', url: '/' })).body;
    expect(html).toMatch(/apple-mobile-web-app-capable/);
  });
});
