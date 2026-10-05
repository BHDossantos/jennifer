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

describe('chained voice (push to talk)', () => {
  it('transcribes, answers through chat, applies pronunciations and speaks; timings recorded', async () => {
    const { applyPronunciations } = await import('../../src/voice/chained.js');
    expect(applyPronunciations('Call Marco Bianchi about BIANCHI music', { Bianchi: 'Bee-AHN-kee' })).toBe('Call Marco Bee-AHN-kee about Bee-AHN-kee music');
    expect(applyPronunciations('Bianchini stays', { Bianchi: 'x' })).toBe('Bianchini stays');

    const { createJennifer } = await import('../../src/app.js');
    const { ScriptedToolModel } = await import('../../src/core/agentLoop.js');
    const { buildServer } = await import('../../src/api/server.js');
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
      if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'Remind me to call Bianchi' }), { status: 200 });
      if (url.endsWith('/audio/speech')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const toolModel = new ScriptedToolModel(() => [{ type: 'assistant', text: 'Sure, I will remind you to call Bianchi.' }]);
    const j = createJennifer({ fetchImpl, toolModel, config: { openai: { apiKey: 'sk-test-abcdefghijklmnopqrstuvwxyz' } } as never, inventoryPath: null as never });
    await j.settings.set('voice', { pronunciations: { Bianchi: 'Bee-AHN-kee' }, voiceId: 'coral', mode: 'private' });
    const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
    const r = await app.inject({ method: 'POST', url: '/v1/voice/turn?language=en', headers: { authorization: 'Bearer owner-token-0123456789', 'content-type': 'audio/webm' }, payload: Buffer.alloc(4000, 1) });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ transcript: 'Remind me to call Bianchi', reply: 'Sure, I will remind you to call Bianchi.', audioBase64: Buffer.from([1, 2, 3]).toString('base64') });
    const tts = calls.find((c) => c.url.endsWith('/audio/speech'))!.body as { input: string; voice: string };
    expect(tts).toMatchObject({ input: 'Sure, I will remind you to call Bee-AHN-kee.', voice: 'coral' });
    expect(j.metrics.snapshot().latenciesMs.voice_chained_total_ms!.n).toBe(1);
  });
});

describe('British voice and private persona', () => {
  it('private mode: British accent, sultry delivery, no AI disclaimers to Bruno; business mode still introduces itself honestly', async () => {
    const { personaInstructions, DEFAULT_VOICE } = await import('../../src/voice/persona.js');
    const { deliveryDirection } = await import('../../src/voice/realtime.js');
    const priv = personaInstructions('private', DEFAULT_VOICE, 'en');
    expect(priv).toMatch(/British accent/);
    expect(priv).toMatch(/never remind him you are an AI/);
    expect(deliveryDirection('private', DEFAULT_VOICE)).toMatch(/sultry/);
    const biz = personaInstructions('business', DEFAULT_VOICE, 'en');
    expect(biz).toMatch(/AI assistant/);
    expect(biz).not.toMatch(/sultry/);
  });
});

describe('ElevenLabs British voices', () => {
  const XI_KEY = 'xi-test-SECRET-0123456789abcdef';
  const VOICES = {
    voices: [
      { voice_id: 'AmericanVoice01', name: 'Rachel', category: 'premade', labels: { accent: 'american', gender: 'female' } },
      { voice_id: 'BritishVoice001', name: 'Alice', category: 'premade', labels: { accent: 'british', gender: 'female', age: 'middle aged', description: 'confident' }, preview_url: 'https://x/p.mp3' },
      { voice_id: 'BritishMale0001', name: 'George', category: 'premade', labels: { accent: 'british', gender: 'male' } },
    ],
  };

  async function setup(tts?: (url: string) => Response | undefined) {
    const { createJennifer } = await import('../../src/app.js');
    const { ScriptedToolModel } = await import('../../src/core/agentLoop.js');
    const { buildServer } = await import('../../src/api/server.js');
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body, headers: (init.headers ?? {}) as Record<string, string> });
      if (url.endsWith('/v1/voices')) return new Response(JSON.stringify(VOICES), { status: 200 });
      const custom = tts?.(url);
      if (custom) return custom;
      if (url.includes('/v1/text-to-speech/')) return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
      if (url.endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'Call Bianchi' }), { status: 200 });
      if (url.endsWith('/audio/speech')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const toolModel = new ScriptedToolModel(() => [{ type: 'assistant', text: 'Of course, darling. Calling Bianchi now.' }]);
    const j = createJennifer({ fetchImpl, toolModel, config: { openai: { apiKey: 'sk-test-abcdefghijklmnopqrstuvwxyz' }, elevenlabs: { apiKey: XI_KEY } } as never, inventoryPath: null as never });
    const app = buildServer(j, { tokens: { [OWNER]: 'owner' } });
    return { j, app, calls, auth: { authorization: `Bearer ${OWNER}` } };
  }

  it('lists female voices with British accents first and never leaks the API key', async () => {
    const { app, auth, calls } = await setup();
    const res = await app.inject({ method: 'GET', url: '/v1/voice/elevenlabs/voices', headers: auth });
    expect(res.json().voices.map((v: { voiceId: string }) => v.voiceId)).toEqual(['LM5QaByxyWDmNhcQTYiS', 'BritishVoice001', 'AmericanVoice01']);
    expect(res.json().voices[0]).toMatchObject({ recommended: true, inAccount: false });
    expect(res.body).not.toContain(XI_KEY);
    expect(calls[0]!.headers['xi-api-key']).toBe(XI_KEY);
    expect((await app.inject({ method: 'GET', url: '/v1/voice', headers: auth })).json().elevenlabs).toBe(true);
  });

  it("auditions Jennifer's greeting, cached, with the sultry private settings", async () => {
    const { app, auth, calls, j } = await setup();
    const get = () => app.inject({ method: 'GET', url: '/v1/voice/elevenlabs/audition?voice=BritishVoice001&mode=private&lang=en', headers: auth });
    const r = await get();
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/audio\/mpeg/);
    await get();
    const tts = calls.filter((c) => c.url.includes('/v1/text-to-speech/'));
    expect(tts).toHaveLength(1);
    expect(tts[0]!.url).toContain('/v1/text-to-speech/BritishVoice001');
    expect(tts[0]!.body.model_id).toBe('eleven_v4');
    expect(tts[0]!.body.text).toMatch(/^\[warm, intimate\] /);
    expect((await j.costs.totals()).byPurpose.voice_audition).toBeDefined();
    const unknown = await app.inject({ method: 'GET', url: '/v1/voice/elevenlabs/audition?voice=NotOnAccount1&mode=private', headers: auth });
    expect(unknown.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a chosen ElevenLabs voice speaks push-to-talk replies, with pronunciations; unknown voices are refused', async () => {
    const { app, auth, calls } = await setup();
    const bad = await app.inject({ method: 'PUT', url: '/v1/voice/settings', headers: auth, payload: { ttsProvider: 'elevenlabs', elevenVoiceId: 'NotOnAccount1' } });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    await app.inject({ method: 'PUT', url: '/v1/voice/settings', headers: auth, payload: { ttsProvider: 'elevenlabs', elevenVoiceId: 'BritishVoice001', pronunciations: { Bianchi: 'Bee-AHN-kee' } } });
    const r = await app.inject({ method: 'POST', url: '/v1/voice/turn?language=en', headers: { ...auth, 'content-type': 'audio/webm' }, payload: Buffer.alloc(4000, 1) });
    expect(r.statusCode).toBe(200);
    expect(r.json().audioBase64).toBe(Buffer.from([9, 9, 9]).toString('base64'));
    const tts = calls.find((c) => c.url.includes('/v1/text-to-speech/BritishVoice001'))!;
    expect(tts.body.text).toBe('[warm, intimate] Of course, darling. Calling Bee-AHN-kee now.');
    expect(calls.some((c) => c.url.endsWith('/audio/speech'))).toBe(false);
    // Switching back uses OpenAI again.
    await app.inject({ method: 'PUT', url: '/v1/voice/settings', headers: auth, payload: { ttsProvider: 'openai' } });
    await app.inject({ method: 'POST', url: '/v1/voice/turn?language=en', headers: { ...auth, 'content-type': 'audio/webm' }, payload: Buffer.alloc(4000, 1) });
    expect(calls.some((c) => c.url.endsWith('/audio/speech'))).toBe(true);
  });

  it("speaks in Bruno's chosen voice (LM5QaByxyWDmNhcQTYiS) by default, and explains how to add it if ElevenLabs can't find it", async () => {
    const { app, auth, calls } = await setup();
    const v = (await app.inject({ method: 'GET', url: '/v1/voice', headers: auth })).json();
    expect(v.settings).toMatchObject({ ttsProvider: 'elevenlabs', elevenVoiceId: 'LM5QaByxyWDmNhcQTYiS' });
    const r = await app.inject({ method: 'POST', url: '/v1/voice/turn?language=en', headers: { ...auth, 'content-type': 'audio/webm' }, payload: Buffer.alloc(4000, 1) });
    expect(r.statusCode).toBe(200);
    expect(calls.some((c) => c.url.includes('/v1/text-to-speech/LM5QaByxyWDmNhcQTYiS'))).toBe(true);
    const a = await app.inject({ method: 'GET', url: '/v1/voice/elevenlabs/audition?voice=LM5QaByxyWDmNhcQTYiS&mode=private', headers: auth });
    expect(a.statusCode).toBe(200);

    const missing = await setup((url) => (url.includes('/v1/text-to-speech/') ? new Response(JSON.stringify({ detail: { status: 'voice_not_found', message: 'A voice with the voice_id was not found.' } }), { status: 404 }) : undefined));
    const m = await missing.app.inject({ method: 'GET', url: '/v1/voice/elevenlabs/audition?voice=LM5QaByxyWDmNhcQTYiS&mode=private', headers: missing.auth });
    expect(m.json().message).toMatch(/Add to my voices/);
  });

  it('falls back to eleven_multilingual_v2 when the account cannot use eleven_v4', async () => {
    const models: string[] = [];
    const { ElevenLabsTTS } = await import('../../src/voice/elevenlabs.js');
    const tts = new ElevenLabsTTS({
      apiKey: XI_KEY,
      model: 'eleven_v4',
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const m = JSON.parse(String(init.body)).model_id as string;
        models.push(m);
        return m === 'eleven_v4' ? new Response(JSON.stringify({ detail: { status: 'invalid_model', message: 'model_id eleven_v4 is not available' } }), { status: 400 }) : new Response(new Uint8Array([7]), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const s = { warmth: 0.8, playfulness: 0.5, speakingRate: 1 };
    expect([...(await tts.speak('Hello', 'LM5QaByxyWDmNhcQTYiS', 'private', s))]).toEqual([7]);
    await tts.speak('Again', 'LM5QaByxyWDmNhcQTYiS', 'business', s);
    expect(models).toEqual(['eleven_v4', 'eleven_multilingual_v2', 'eleven_multilingual_v2']);
    expect(tts.body('Hello', 'business', s, 'eleven_multilingual_v2').voice_settings).toMatchObject({ stability: 0.65 });
  });
});
