import { newId } from '../core/util.js';
import { renderUntrusted, wrapUntrusted } from '../security/untrusted.js';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ACTION_MODES, ACTION_TYPES, JenniferError, SPACES } from '../core/types.js';
import type { Jennifer } from '../app.js';
import { verifyWebhookSignature } from '../events/events.js';
import { registerCompanyRoutes } from './companyRoutes.js';
import { verifyTwilioSignature } from '../connectors/sms/twilio.js';
import { verifyWebhookToken, type BlueBubblesMessage } from '../connectors/imessage/bluebubbles.js';
import { toE164, verifyMetaSignature, type WhatsAppWebhookValue } from '../connectors/whatsapp/cloud.js';
import { redactSecrets } from '../security/redaction.js';
import { DASHBOARD_HTML } from './dashboard.js';
import { MANIFEST, SERVICE_WORKER, appIcon } from './pwa.js';
import { FEMALE_VOICE_CANDIDATES } from '../voice/realtime.js';
import { MISSION_PRESETS, MissionInputSchema } from '../missions/missions.js';
import { PrefsSchema, PushSubscriptionSchema } from '../notify/push.js';
import { DEFAULT_VOICE, type VoiceSettings } from '../voice/persona.js';
import type { IdentityService, Session } from '../identity/identity.js';
import type { GmailService } from '../connectors/gmail/service.js';
import type { CalendarConnections } from '../calendar/remotes.js';
import { inventoryBlockers } from '../setup/inventory.js';
import { AUTHORITY_TEMPLATES, enableTemplate } from '../policy/templates.js';

export type Role = 'owner' | 'developer' | 'operator';

export interface ServerOptions {
  /** token → role. Developer/operator roles never see private correspondence. */
  tokens: Record<string, Role>;
  webhookSecret?: string;
  logger?: boolean;
  /** Passkey sessions. Static tokens are a bootstrap/break-glass path and can never satisfy step-up. */
  identity?: IdentityService;
  gmail?: GmailService;
  calendars?: CalendarConnections;
}

declare module 'fastify' {
  interface FastifyRequest {
    role?: Role;
    rawBody?: string;
    session?: Session;
  }
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/**
 * Versioned API (spec §15). Every read and mutation requires an authenticated
 * role; provider webhooks use signature verification instead.
 */
export function buildServer(j: Jennifer, opts: ServerOptions) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  const tokenDigests = Object.entries(opts.tokens).map(([t, role]) => ({ d: digest(t), role }));

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  const auth = (...roles: Role[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const d = digest(token);
    const match = token ? tokenDigests.find((t) => timingSafeEqual(t.d, d)) : undefined;
    let role = match?.role;
    if (!role && token && opts.identity) {
      const session = await opts.identity.authenticate(token);
      if (session) {
        req.session = session;
        role = session.role;
      }
    }
    if (!role) return reply.code(401).send({ error: 'unauthorized' });
    if (!roles.includes(role)) return reply.code(403).send({ error: 'forbidden' });
    req.role = role;
  };
  const requireIdentity = () => {
    if (!opts.identity) throw new JenniferError('identity.not_configured', 'Passkeys need the durable database');
    return opts.identity;
  };
  const requireSession = (req: FastifyRequest) => {
    if (!req.session) throw new JenniferError('identity.session_required', 'Sign in with a passkey for this action');
    return req.session;
  };
  const owner = { preHandler: auth('owner') };
  const anyone = { preHandler: auth('owner', 'developer', 'operator') };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof JenniferError) return reply.code(err.code.endsWith('not_found') ? 404 : 409).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request', issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: 'error', message: redactSecrets((err as Error).message) });
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/', async (_req, reply) => reply.type('text/html').header('cache-control', 'no-cache').send(DASHBOARD_HTML));
  app.get('/manifest.webmanifest', async (_req, reply) => reply.type('application/manifest+json').send(MANIFEST));
  app.get('/sw.js', async (_req, reply) => reply.type('text/javascript').header('cache-control', 'no-cache').send(SERVICE_WORKER));
  app.get('/icon-192.png', async (_req, reply) => reply.type('image/png').send(appIcon(192)));
  app.get('/icon-512.png', async (_req, reply) => reply.type('image/png').send(appIcon(512)));
  app.get('/apple-touch-icon.png', async (_req, reply) => reply.type('image/png').send(appIcon(180)));

  // ---- Today / Connections ------------------------------------------------
  app.get('/v1/today', owner, async () => ({
    brief: j.dailyBrief(),
    awaitingDecision: j.actions.list({ state: 'awaiting_decision' }).map(approvalCard),
    controls: j.controls.status(),
    activity: j.agents.activityFeed().slice(-20),
  }));
  app.get('/v1/connections', anyone, async () => j.capabilities.screen());
  /** First-run checklist: Bruno's remaining setup steps, with live status. */
  app.get('/v1/onboarding', owner, async () => {
    const cap = (id: string) => !!j.capabilities.get(id)?.connected;
    const steps = [
      { id: 'openai', title: 'Server has an OpenAI API key (voice and phone; also chat and missions unless Claude is chosen)', done: !!j.config.openai.apiKey },
      { id: 'passkey', title: 'Sign in with Face ID (passkey) on your iPhone', done: opts.identity ? await opts.identity.hasPasskey(j.ownerId) : false },
      { id: 'voice', title: "Choose Jennifer's voice", done: !!(await j.settings.get('voice')), tab: 'voice' },
      { id: 'gmail', title: 'Connect your Gmail (app password)', done: cap('gmail'), tab: 'connections' },
      { id: 'calendar', title: 'Connect your calendar (iCloud and/or Google)', done: cap('icloud_calendar') || cap('google_calendar_ics'), tab: 'connections' },
      { id: 'notifications', title: 'Turn on notifications', done: (await j.notifications.subscriptions()).length > 0, tab: 'settings' },
      { id: 'mission', title: 'Start your first mission', done: (await j.missions.list()).some((m) => m.status !== 'archived'), tab: 'missions' },
      { id: 'phone', title: 'Optional: phone number for calls', done: j.phone.configured, optional: true },
    ];
    return { steps, remaining: steps.filter((s) => !s.done && !s.optional).length };
  });
  app.get('/v1/setup', owner, async () => ({
    inventory: j.inventory,
    blockers: j.inventory ? inventoryBlockers(j.inventory) : [{ area: 'setup', missing: 'config/inventory.json', why: 'No inventory loaded', owner: 'engineering' }],
    templates: AUTHORITY_TEMPLATES,
  }));

  // ---- Actions & approvals ------------------------------------------------
  app.get('/v1/actions', owner, async (req) => {
    const q = z.object({ state: z.string().optional() }).parse(req.query);
    return j.actions.list({ state: q.state as never }).map(approvalCard);
  });
  app.get('/v1/actions/:id', owner, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const a = j.actions.get(id);
    return { ...approvalCard(a), history: a.history, receipt: a.receipt, payloadRaw: a.payload };
  });
  app.post('/v1/actions/:id/approve', owner, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ revision: z.number().int(), payloadHash: z.string() }).parse(req.body);
    // Step-up comes only from a recent passkey assertion on this session, never from the request body.
    const stepUpVerified = !!req.session && !!opts.identity?.hasRecentStepUp(req.session);
    const approval = j.actions.approve(id, j.ownerId, { revision: b.revision, payloadHash: b.payloadHash }, { stepUpVerified });
    const result = await j.actions.execute(id);
    return { approvalId: approval.id, state: result.state, receipt: result.receipt, reason: result.stateReason };
  });
  app.post('/v1/actions/:id/edit', owner, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ payload: z.record(z.string(), z.unknown()) }).parse(req.body);
    return approvalCard(j.actions.edit(id, j.ownerId, b.payload));
  });
  app.post('/v1/actions/:id/cancel', owner, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    // Optional "why": wrong fact, wrong recipient, poor tone... becomes learning feedback.
    const b = z.object({ reason: z.enum(['rejected', 'wrong_fact', 'wrong_recipient', 'poor_tone', 'incomplete_action', 'escalation_needed', 'handed_off']).default('rejected'), note: z.string().max(500).optional() }).parse(req.body ?? {});
    const wasDecision = j.actions.get(id).state === 'awaiting_decision';
    const canceled = j.actions.cancel(id, j.ownerId, b.note ? `canceled by Bruno: ${b.note}` : 'canceled by Bruno');
    if (canceled && wasDecision && b.reason !== 'handed_off') j.learning.rejected(id, b.reason, b.note);
    return { canceled };
  });
  registerCompanyRoutes(app, j, owner);

  // ---- Conversations ---------------------------------------------------------
  app.get('/v1/conversations', owner, async (req) => {
    const q = z.object({ space: z.enum(SPACES).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const pending = j.actions.list({ ownerId: j.ownerId }).filter((a) => a.conversationId && ['proposed', 'validated', 'awaiting_decision', 'ready'].includes(a.state));
    return j.conversations
      .listConversations(j.ownerId)
      .filter((c) => !q.space || c.space === q.space)
      .map((c) => {
        const msgs = j.conversations.messagesIn(c.id);
        const last = msgs.at(-1);
        return { id: c.id, subject: c.subject, space: c.space, channel: c.channel, lastAt: last?.occurredAt, lastFrom: last?.from, lastPreview: last?.body.slice(0, 160), messages: msgs.length, pendingActions: pending.filter((a) => a.conversationId === c.id).length };
      })
      .sort((a, b) => (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0))
      .slice(0, q.limit);
  });
  /** Conversation detail: messages in order with drafts, attachments and receipts. */
  app.get('/v1/conversations/:id', owner, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const c = j.conversations.getConversation(id);
    if (c.ownerId !== j.ownerId) throw new JenniferError('conversation.not_found', 'No such conversation');
    const actions = j.actions.list({ ownerId: j.ownerId }).filter((a) => a.conversationId === id);
    return {
      conversation: { id: c.id, subject: c.subject, space: c.space, channel: c.channel, accountId: c.accountId },
      messages: j.conversations.messagesIn(id).map((m) => ({
        id: m.id,
        direction: m.direction,
        from: m.from,
        to: m.to,
        cc: m.cc,
        subject: m.subject,
        body: m.body,
        at: m.occurredAt,
        flags: m.flags,
        attachments: (m.attachmentIds ?? []).map((aid) => {
          const a = j.conversations.getAttachment(aid);
          return { id: a.id, filename: a.filename, scanStatus: a.scanStatus, space: a.space };
        }),
      })),
      actions: actions.map((a) => ({ ...approvalCard(a), receipt: a.receipt, history: a.history.slice(-5) })),
    };
  });
  app.get('/v1/contacts', owner, async () => j.contacts.list(j.ownerId).map((c) => ({ id: c.id, name: c.displayName, spaces: c.spaces, identities: c.identities.map((i) => ({ kind: i.kind, value: i.value, verified: i.verified })), paused: j.controls.status().pausedContacts.includes(c.id) })));

  // ---- Problems: dead letters with a recovery action -------------------------
  app.get('/v1/dead-letters', owner, async () => j.deadLetters.list());
  app.post('/v1/dead-letters/:id/dismiss', owner, async (req) => {
    j.deadLetters.remove(z.object({ id: z.string() }).parse(req.params).id);
    return { dismissed: true };
  });
  /** Retry = a fresh proposal of the same action, which waits for Bruno's explicit decision. */
  app.post('/v1/dead-letters/:id/retry', owner, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const d = j.deadLetters.list().find((x) => x.id === id);
    if (!d) throw new JenniferError('dlq.not_found', 'No such problem');
    const a = j.actions.get(d.subjectId);
    if (!['failed', 'canceled'].includes(a.state)) throw new JenniferError('dlq.not_retryable', `The original action is ${a.state}; check it before retrying`);
    const fresh = j.actions.propose({ ownerId: a.ownerId, type: a.type, space: a.space, channel: a.channel, connectorId: a.connectorId, accountId: a.accountId, conversationId: a.conversationId, workflowId: a.workflowId, payload: a.payload, proposedBy: `${j.ownerId}:retry` });
    j.actions.requireDecision(fresh.id, j.ownerId, `retry of ${a.id}`);
    j.deadLetters.remove(id);
    return approvalCard(j.actions.get(fresh.id));
  });

  // ---- Operations: reliability and cost (spec §18) -----------------------------
  /** No correspondence here, so operators may read it too. */
  app.get('/v1/metrics', anyone, async () => {
    const now = j.clock.now().getTime();
    const all = j.actions.list({ ownerId: j.ownerId });
    const byState: Record<string, number> = {};
    for (const a of all) byState[a.state] = (byState[a.state] ?? 0) + 1;
    const stuck = all.filter((a) => (a.state === 'ready' || a.state === 'executing') && now - a.createdAt.getTime() > 10 * 60_000).length;
    const completed = all.filter((a) => a.state === 'provider_accepted' || a.state === 'confirmed').length;
    const costs = await j.costs.totals();
    return {
      at: new Date(now).toISOString(),
      actions: { byState, ambiguous: byState.unknown ?? 0, stuck, completed },
      deadLetters: j.deadLetters.list().length,
      connectors: j.capabilities.list().filter((c) => c.connected || c.accountId).map((c) => ({ id: c.id, connected: c.connected, lastSyncAgeMin: c.lastSuccessfulSyncAt ? Math.round((now - c.lastSuccessfulSyncAt.getTime()) / 60_000) : null, problem: c.lastError })),
      costs: { ...costs, perCompletedActionEur: completed ? +(costs.totalEur / completed).toFixed(4) : null },
      ...j.metrics.snapshot(),
    };
  });
  app.get('/v1/costs', owner, async () => j.costs.totals());

  // ---- Learning: feedback and proposed rules ---------------------------------
  app.get('/v1/feedback', owner, async () => ({ feedback: j.feedback.list().slice(-200).reverse(), rules: j.feedback.allRules() }));
  app.post('/v1/feedback/rules/:id', owner, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ status: z.enum(['approved', 'rejected']) }).parse(req.body);
    // Rules that change contact behavior are a sensitive change.
    if (b.status === 'approved' && j.feedback.allRules().find((r) => r.id === id)?.impact !== 'style') requireSensitive(req);
    return j.feedback.decideRule(id, b.status);
  });

  // ---- Identity: passkeys, step-up, devices ---------------------------------
  /** Sensitive changes (accounts, authority, devices, passkeys): passkey step-up, or the bootstrap token in development only. */
  const requireSensitive = (req: FastifyRequest) => {
    if (req.session) {
      if (!opts.identity?.hasRecentStepUp(req.session)) throw new JenniferError('approval.step_up_required', 'Confirm with your passkey first');
      return;
    }
    if (j.config.env !== 'development') throw new JenniferError('identity.session_required', 'Sign in with a passkey to connect accounts');
  };
  const DeviceInfo = z.object({ platform: z.string().max(40), osVersion: z.string().max(40).optional(), label: z.string().max(80).optional() });
  /** The first passkey is enrolled with the bootstrap token; every later one needs a signed-in, stepped-up session. */
  const registrationSession = async (req: FastifyRequest): Promise<string | undefined> => {
    if (!(await requireIdentity().hasPasskey(j.ownerId))) return req.session?.idHash;
    if (!req.session) throw new JenniferError('identity.session_required', 'Sign in with your existing passkey to add another device');
    requireSensitive(req);
    return req.session.idHash;
  };
  app.post('/v1/auth/passkeys/register/options', owner, async (req) => requireIdentity().registrationOptions(j.ownerId, j.ownerId, await registrationSession(req)));
  // Unusual access alerts (spec §4): new devices, sign-in failures, dormant devices.
  const securityAlert = (title: string, body: string, key: string) =>
    void j.notifications.notify({ kind: 'problem', title, body, url: '/?tab=settings', urgent: true, dedupKey: `security:${key}` }).catch(() => undefined);
  const loginFailures: number[] = [];
  app.post('/v1/auth/passkeys/register/verify', owner, async (req) => {
    const b = z.object({ handle: z.string(), response: z.any(), device: DeviceInfo }).parse(req.body);
    const hadPasskey = await requireIdentity().hasPasskey(j.ownerId);
    const r = await requireIdentity().verifyRegistration(b.handle, b.response, b.device, await registrationSession(req));
    if (hadPasskey) securityAlert('Jennifer: a new device was added', `A passkey for ${b.device.platform}${b.device.label ? ` (${b.device.label})` : ''} can now sign in. If this wasn't you, revoke it in Settings.`, r.deviceId);
    return r;
  });
  app.post('/v1/auth/passkeys/login/options', async () => requireIdentity().loginOptions(j.ownerId));
  app.post('/v1/auth/passkeys/login/verify', async (req) => {
    const b = z.object({ handle: z.string(), response: z.any() }).parse(req.body);
    const before = (await requireIdentity().devices(j.ownerId)) as Array<{ id: string; last_seen_at?: string | Date | null }>;
    let result;
    try {
      result = await requireIdentity().verifyLogin(b.handle, b.response);
    } catch (e) {
      const now = j.clock.now().getTime();
      loginFailures.push(now);
      while (loginFailures.length && now - loginFailures[0]! > 10 * 60_000) loginFailures.shift();
      if (loginFailures.length >= 5) securityAlert('Jennifer: repeated sign-in failures', `${loginFailures.length} failed passkey sign-ins in 10 minutes.`, `fail:${Math.floor(now / 600_000)}`);
      throw e;
    }
    const { token, session } = result;
    const prev = before.find((d) => d.id === session.deviceId)?.last_seen_at;
    if (prev && j.clock.now().getTime() - new Date(prev).getTime() > 30 * 24 * 3600_000)
      securityAlert('Jennifer: sign-in from a device unused for a month', 'If this wasn\'t you, revoke the device in Settings.', `dormant:${session.deviceId}:${session.idHash.slice(0, 8)}`);
    return { token, expiresAt: session.expiresAt };
  });
  app.post('/v1/auth/step-up/options', owner, async (req) => requireIdentity().stepUpOptions(requireSession(req)));
  app.post('/v1/auth/step-up/verify', owner, async (req) => {
    const b = z.object({ handle: z.string(), response: z.any() }).parse(req.body);
    return { stepUpAt: await requireIdentity().verifyStepUp(requireSession(req), b.handle, b.response) };
  });
  app.post('/v1/auth/logout', owner, async (req) => {
    await requireIdentity().logout(requireSession(req));
    return { ok: true };
  });
  app.get('/v1/devices', owner, async () => requireIdentity().devices(j.ownerId));
  app.delete('/v1/devices/:id', owner, async (req) => {
    // Sessions need a fresh passkey; the bootstrap token stays a break-glass path for a stolen phone.
    if (req.session) requireSensitive(req);
    await requireIdentity().revokeDevice(j.ownerId, z.object({ id: z.string() }).parse(req.params).id, j.ownerId);
    return { revoked: true };
  });

  // ---- Voice -----------------------------------------------------------------
  const VOICE_TOOLS = ['get_today_brief', 'list_pending_decisions', 'list_missions', 'get_calendar', 'find_free_slots', 'propose_event', 'search_messages', 'read_thread', 'retrieve_memory', 'create_draft', 'search_ai_history', 'web_search', 'ask_ai', 'company_overview', 'start_company_workflow'];
  const voiceCtx = { ownerId: j.ownerId, role: 'voice', allowedTools: new Set(VOICE_TOOLS), scopes: new Set(['brief:read', 'actions:read', 'messages:read', 'memory:read', 'messages:propose', 'calendar:read', 'calendar:propose', 'history:read', 'web:read', 'company:read', 'company:run']) };
  type StoredVoice = VoiceSettings & { mode: 'private' | 'business' };
  const voiceSettings = async (): Promise<StoredVoice> => ({ ...DEFAULT_VOICE, voiceId: 'marin', mode: 'private', ...(await j.settings.get<StoredVoice>('voice')) });
  const Lang = z.enum(['en', 'pt-BR', 'es', 'it']);

  app.get('/v1/voice', owner, async () => ({ configured: j.voice.configured, candidates: FEMALE_VOICE_CANDIDATES, settings: await voiceSettings() }));
  app.put('/v1/voice/settings', owner, async (req) => {
    const b = z
      .object({
        voiceId: z.enum(FEMALE_VOICE_CANDIDATES.map((c) => c.id) as [string, ...string[]]).optional(),
        warmth: z.number().min(0).max(1).optional(),
        speakingRate: z.number().min(0.75).max(1.25).optional(),
        playfulness: z.number().min(0).max(1).optional(),
        verbosity: z.enum(['brief', 'normal', 'detailed']).optional(),
        mode: z.enum(['private', 'business']).optional(),
        provider: z.enum(['realtime_s2s', 'chained_asr_llm_tts']).optional(),
        accent: z.enum(['british', 'american', 'australian', 'neutral']).optional(),
        /** How to say names and words, e.g. {"Bianchi": "Bee-AHN-kee"}. */
        pronunciations: z.record(z.string().min(1).max(60), z.string().min(1).max(120)).optional(),
      })
      .parse(req.body);
    const next = { ...(await voiceSettings()), ...b };
    await j.settings.set('voice', next);
    j.audit.record(j.ownerId, 'voice.settings_changed', undefined, { voiceId: next.voiceId, mode: next.mode });
    return next;
  });
  app.get('/v1/voice/audition', owner, async (req, reply) => {
    const q = z.object({ voice: z.string(), mode: z.enum(['private', 'business']).default('private'), lang: Lang.default('en') }).parse(req.query);
    const audio = await j.voice.sample(q.voice, q.mode, q.lang, await voiceSettings());
    return reply.type('audio/mpeg').header('cache-control', 'private, max-age=86400').send(audio);
  });
  /** Ephemeral realtime credentials for the app; the OpenAI API key never leaves the server. */
  /**
   * Chained voice (push-to-talk): audio in → transcript → Jennifer's chat
   * (same tools and rules) → spoken reply. Exact transcripts, pronunciation
   * dictionary applied, latency per stage recorded.
   */
  app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: 15 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post('/v1/voice/turn', { ...owner, bodyLimit: 15 * 1024 * 1024 }, async (req) => {
    await j.costs.assertBudget('voice conversations');
    if (!Buffer.isBuffer(req.body) || req.body.length < 200) throw new JenniferError('voice.no_audio', 'Send the recording as audio/* (webm, m4a, wav or mp3)');
    const q = z.object({ language: Lang.default('en'), sessionId: z.string().max(80).optional() }).parse(req.query);
    const s = await voiceSettings();
    let sessionId = q.sessionId;
    const turn = await j.chainedVoice.turn({ audio: req.body as Buffer, mime: String(req.headers['content-type']), language: q.language, voice: s.voiceId ?? 'marin', mode: s.mode, settings: s }, async (text) => {
      const r = await j.chat.send({ sessionId, message: text, mode: s.mode });
      sessionId = r.sessionId;
      return r.reply;
    });
    for (const [k, v] of Object.entries(turn.timingsMs)) j.metrics.observe(`voice_chained_${k}_ms`, v);
    // Audio minutes in and out, roughly: recording size is unknown in seconds, so use the reply length as the estimate.
    await j.costs.record('voice', 'voice_chained', (turn.reply.length / 900) * j.costs.pricing.voicePerMinute);
    return { sessionId, transcript: turn.transcript, reply: turn.reply, audioBase64: turn.audio.toString('base64'), timingsMs: turn.timingsMs };
  });
  /** The app reports how long a live voice conversation lasted (cost ledger). */
  app.post('/v1/voice/usage', owner, async (req) => {
    const b = z.object({ seconds: z.number().min(0).max(4 * 3600) }).parse(req.body);
    await j.costs.record('voice', 'voice_session', (b.seconds / 60) * j.costs.pricing.voicePerMinute);
    return { ok: true };
  });
  app.post('/v1/voice/session', owner, async (req) => {
    await j.costs.assertBudget('voice conversations');
    const b = z.object({ language: Lang.default('en'), mode: z.enum(['private', 'business']).optional() }).parse(req.body ?? {});
    const s = await voiceSettings();
    const tools = j.tools.forRole(voiceCtx).map((t) => {
      const { $schema: _drop, ...parameters } = t.schema as Record<string, unknown>;
      return { name: t.name, description: t.description, parameters };
    });
    const session = await j.voice.createSession({ settings: s, mode: b.mode ?? s.mode, language: b.language, tools });
    j.audit.record(j.ownerId, 'voice.session_started', undefined, { voice: session.voice, model: session.model });
    return session;
  });
  /** Tool calls from a live voice session run here, through the same registry and policy as everything else. */
  app.post('/v1/voice/tools/:name', owner, async (req) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const b = z.object({ arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).default({}) }).parse(req.body ?? {});
    const args = typeof b.arguments === 'string' ? JSON.parse(b.arguments || '{}') : b.arguments;
    try {
      // The realtime model receives this verbatim: label third-party content as untrusted.
      const out = JSON.stringify(await j.tools.invoke(name, args, voiceCtx));
      return { ok: true, result: renderUntrusted(wrapUntrusted(`tool:${name}`, out), newId('n').slice(2, 10)) };
    } catch (e) {
      return { ok: false, error: e instanceof JenniferError ? e.message : 'Tool failed' };
    }
  });

  // ---- Push notifications ----------------------------------------------------
  app.get('/v1/push/key', owner, async () => ({ publicKey: (await j.notifications.keys()).publicKey }));
  app.post('/v1/push/subscribe', owner, async (req) => {
    const b = z.object({ subscription: PushSubscriptionSchema, label: z.string().max(80).optional() }).parse(req.body);
    await j.notifications.subscribe(b.subscription, b.label);
    return { subscribed: true };
  });
  app.post('/v1/push/unsubscribe', owner, async (req) => {
    await j.notifications.unsubscribe(z.object({ endpoint: z.string().url() }).parse(req.body).endpoint);
    return { unsubscribed: true };
  });
  app.post('/v1/push/test', owner, async () => ({
    result: await j.notifications.notify({ kind: 'decision', title: 'Jennifer', body: 'Notifications are working.', url: '/', urgent: true, dedupKey: `test:${Date.now()}` }),
  }));
  app.get('/v1/notifications/prefs', owner, async () => j.notifications.prefs());
  app.put('/v1/notifications/prefs', owner, async (req) => j.notifications.setPrefs(PrefsSchema.partial().parse(req.body ?? {})));

  // ---- Chat ("Ask Jennifer") -------------------------------------------------
  app.post('/v1/chat', owner, async (req) => {
    const b = z.object({ sessionId: z.string().optional(), message: z.string().min(1).max(4000), mode: z.enum(['private', 'business']).optional() }).parse(req.body);
    return j.chat.send(b);
  });
  app.get('/v1/memory/pending', owner, async () => j.memory.all(j.ownerId).filter((m) => m.status === 'pending_review'));
  app.post('/v1/memory/:id/activate', owner, async (req) => j.memory.activate(z.object({ id: z.string() }).parse(req.params).id));

  // ---- Missions (always-on agents) -------------------------------------------
  app.get('/v1/missions', owner, async () => ({ missions: await j.missions.list(), presets: MISSION_PRESETS }));
  app.post('/v1/missions', owner, async (req) => {
    const b = z.object({ preset: z.string().optional() }).passthrough().parse(req.body ?? {});
    const preset = b.preset ? MISSION_PRESETS.find((p) => p.id === b.preset) : undefined;
    if (b.preset && !preset) throw new JenniferError('mission.unknown_preset', 'Unknown preset');
    const { preset: _p, ...rest } = b;
    const { id: _id, ...presetInput } = preset ?? ({} as Record<string, unknown>);
    return j.missions.create(MissionInputSchema.parse({ ...presetInput, ...rest }), j.ownerId);
  });
  app.get('/v1/missions/:id', owner, async (req) => j.missions.get(z.object({ id: z.string() }).parse(req.params).id));
  app.patch('/v1/missions/:id', owner, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const patch = MissionInputSchema.partial().parse(req.body ?? {});
    return j.missions.update(id, patch, j.ownerId);
  });
  for (const status of ['pause', 'resume', 'archive'] as const)
    app.post(`/v1/missions/:id/${status}`, owner, async (req) =>
      j.missions.setStatus(z.object({ id: z.string() }).parse(req.params).id, status === 'pause' ? 'paused' : status === 'resume' ? 'active' : 'archived', j.ownerId),
    );
  app.post('/v1/missions/:id/run', owner, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ mode: z.enum(['research', 'work']).default('work'), reason: z.string().max(500).default('Bruno asked') }).parse(req.body ?? {});
    return j.missions.run(id, b.mode, b.reason);
  });
  app.post('/v1/missions/:id/results/:rid', owner, async (req) => {
    const p = z.object({ id: z.string(), rid: z.string() }).parse(req.params);
    const b = z.object({ status: z.enum(['reviewed', 'dismissed']) }).parse(req.body);
    return j.missions.review(p.id, p.rid, b.status);
  });

  // ---- Connectors: Gmail ----------------------------------------------------
  const requireGmail = () => {
    if (!opts.gmail) throw new JenniferError('gmail.not_configured', 'Gmail needs the durable database and a vault key');
    return opts.gmail;
  };
  app.get('/v1/connectors/gmail', owner, async () => (opts.gmail ? opts.gmail.info() : { configured: false }));
  app.post('/v1/connectors/gmail/connect', owner, async (req) => {
    requireSensitive(req);
    const b = z.object({ address: z.string().email(), appPassword: z.string().min(16).max(40) }).parse(req.body);
    return requireGmail().connect(b.address, b.appPassword, j.ownerId);
  });
  app.post('/v1/connectors/gmail/disconnect', owner, async () => {
    await requireGmail().disconnect(j.ownerId);
    return { disconnected: true };
  });
  app.post('/v1/connectors/gmail/sync', owner, async () => ({ newMessages: await requireGmail().syncNow() }));
  app.post('/v1/connectors/gmail/import', owner, async (req) => {
    const b = z.object({ days: z.number().int().min(1).max(30).default(7) }).parse(req.body ?? {});
    return requireGmail().importHistory(b.days, j.ownerId);
  });

  // ---- Connectors: calendars -------------------------------------------------
  const requireCalendars = () => {
    if (!opts.calendars) throw new JenniferError('calendar.not_configured', 'Calendars need the durable database and a vault key');
    return opts.calendars;
  };
  app.get('/v1/connectors/calendar', owner, async () => ({
    calendars: j.calendar.remotes.map((r) => ({ id: r.id, label: r.label, writable: r.writable })),
    lastSync: j.calendar.lastSync?.toISOString() ?? null,
  }));
  app.post('/v1/connectors/icloud-calendar/connect', owner, async (req) => {
    requireSensitive(req);
    const b = z.object({ appleId: z.string().email(), appPassword: z.string().min(16).max(40), calendar: z.string().max(80).optional() }).parse(req.body);
    return requireCalendars().connectICloud(b.appleId, b.appPassword, j.ownerId, b.calendar);
  });
  app.post('/v1/connectors/calendar-feed/connect', owner, async (req) => {
    requireSensitive(req);
    const b = z.object({ url: z.string().min(10).max(2000), label: z.string().max(80).default('Google Calendar') }).parse(req.body);
    return requireCalendars().connectIcsFeed(b.url, b.label, j.ownerId);
  });
  /** Google Calendar read/write: start Google sign-in (sensitive), then Google redirects to the callback. */
  app.post('/v1/connectors/google-calendar/start', owner, async (req) => {
    requireSensitive(req);
    return requireCalendars().startGoogle();
  });
  /** Public by necessity (Google's browser redirect); authorized by the single-use state created above. */
  app.get('/v1/connectors/google-calendar/callback', async (req, reply) => {
    const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
    if (q.error || !q.code || !q.state) return reply.redirect(`/?tab=connections&google=${encodeURIComponent(q.error ?? 'cancelled')}`);
    try {
      await requireCalendars().finishGoogle(q.code, q.state, j.ownerId);
      return reply.redirect('/?tab=connections&google=connected');
    } catch (e) {
      return reply.redirect(`/?tab=connections&google=${encodeURIComponent(e instanceof JenniferError ? e.code : 'failed')}`);
    }
  });
  app.post('/v1/connectors/calendar/sync', owner, async () => requireCalendars().syncNow());
  app.post('/v1/connectors/calendar/:id/disconnect', owner, async (req) => {
    await requireCalendars().disconnect(z.object({ id: z.string() }).parse(req.params).id, j.ownerId);
    return { disconnected: true };
  });

  // ---- Authority registry --------------------------------------------------
  app.get('/v1/authority', owner, async () => j.authority.list());
  app.post('/v1/authority', owner, async (req) => {
    requireSensitive(req);
    const b = z
      .object({
        action: z.enum(ACTION_TYPES),
        mode: z.enum(ACTION_MODES),
        scope: z.object({ accountIds: z.array(z.string()).optional(), contactIds: z.array(z.string()).optional(), domains: z.array(z.string()).optional(), spaces: z.array(z.enum(SPACES)).optional() }),
        limits: z.object({ maxAmountEur: z.number().optional(), maxRecipients: z.number().int().optional() }).optional(),
        expiresAt: z.coerce.date().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);
    return j.authority.grant({ ...b, principal: j.ownerId });
  });
  app.post('/v1/authority/templates/:templateId', owner, async (req) => {
    requireSensitive(req);
    const { templateId } = z.object({ templateId: z.string() }).parse(req.params);
    const b = z
      .object({
        scope: z.object({ accountIds: z.array(z.string()).optional(), contactIds: z.array(z.string()).optional(), domains: z.array(z.string()).optional(), spaces: z.array(z.enum(SPACES)).optional() }),
        expiresAt: z.coerce.date().optional(),
      })
      .parse(req.body);
    return enableTemplate(j.authority, templateId, j.ownerId, b.scope, b.expiresAt);
  });
  app.delete('/v1/authority/:id', owner, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    j.authority.revoke(id, j.ownerId);
    return { revoked: true };
  });

  // ---- Controls ------------------------------------------------------------
  app.post('/v1/controls/emergency-stop', owner, async () => {
    j.controls.emergencyStop(j.ownerId);
    return j.controls.status();
  });
  app.post('/v1/controls/pause', owner, async (req) => {
    const b = z.object({ connectorId: z.string().optional(), contactId: z.string().optional() }).parse(req.body ?? {});
    if (b.connectorId) j.controls.pauseConnector(j.ownerId, b.connectorId);
    else if (b.contactId) j.controls.pauseContact(j.ownerId, b.contactId);
    else j.controls.pauseAll(j.ownerId);
    return j.controls.status();
  });
  app.post('/v1/controls/resume', owner, async (req) => {
    const b = z.object({ connectorId: z.string().optional(), contactId: z.string().optional() }).parse(req.body ?? {});
    if (b.connectorId) j.controls.resumeConnector(j.ownerId, b.connectorId);
    else if (b.contactId) j.controls.resumeContact(j.ownerId, b.contactId);
    else j.controls.resumeAll(j.ownerId);
    return j.controls.status();
  });
  app.post('/v1/suppressions', owner, async (req) => {
    const b = z.object({ contactId: z.string().optional(), address: z.string().optional(), domain: z.string().optional(), reason: z.string() }).parse(req.body);
    return j.suppressions.add({ ...b, channels: 'all', createdBy: j.ownerId });
  });

  // ---- Memory --------------------------------------------------------------
  app.get('/v1/memory', owner, async (req) => {
    const q = z.object({ q: z.string().default(''), space: z.enum(SPACES).optional() }).parse(req.query);
    if (!q.q) return j.memory.all(j.ownerId);
    return j.memory.retrieve({ ownerId: j.ownerId, text: q.q, spaces: q.space ? [q.space] : [...SPACES], maxSensitivity: 'restricted' });
  });
  app.get('/v1/memory/:id/why', owner, async (req) => j.memory.why(z.object({ id: z.string() }).parse(req.params).id));
  app.delete('/v1/memory/:id', owner, async (req) => {
    j.memory.delete(z.object({ id: z.string() }).parse(req.params).id, j.ownerId);
    return { deleted: true };
  });
  app.get('/v1/memory/reviews', owner, async () => j.memory.openReviews());
  /** Bruno corrects a memory: the old entry is superseded, never silently overwritten. */
  app.post('/v1/memory/:id/correct', owner, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ value: z.string().min(2).max(2000) }).parse(req.body);
    return j.memory.correct(id, j.ownerId, b.value, `Corrected by Bruno in the app`);
  });
  app.get('/v1/memory/export', owner, async (_req, reply) =>
    reply.header('content-disposition', 'attachment; filename="jennifer-memory.json"').send({ exportedAt: j.clock.now(), entries: j.memory.export(j.ownerId) }),
  );
  // ---- ChatGPT / Claude history (explicit exports and shared clips) ---------
  /** Legacy: raw ChatGPT conversations.json text. */
  app.post('/v1/memory/import/chatgpt', owner, async (req) => {
    const b = z.object({ export: z.string() }).parse(req.body);
    return j.history.importExport({ json: b.export }, j.ownerId);
  });
  /** Upload the export as downloaded: the .zip (base64) or conversations.json (+ Claude projects.json). */
  app.post('/v1/history/import', { ...owner, bodyLimit: 300 * 1024 * 1024 }, async (req) => {
    const b = z.object({ zipBase64: z.string().max(400 * 1024 * 1024).optional(), json: z.string().optional(), projectsJson: z.string().optional() }).refine((x) => x.zipBase64 || x.json, 'zipBase64 or json is required').parse(req.body);
    return j.history.importExport(b, j.ownerId);
  });
  /** The .zip as raw bytes (what the dashboard sends). Large ChatGPT zips with images: unzip in Files and upload conversations.json. */
  app.addContentTypeParser(['application/zip', 'application/octet-stream'], { parseAs: 'buffer', bodyLimit: 200 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post('/v1/history/import-zip', { ...owner, bodyLimit: 200 * 1024 * 1024 }, async (req) => {
    if (!Buffer.isBuffer(req.body)) throw new JenniferError('history.bad_zip', 'Send the .zip file as application/zip');
    return j.history.importExport({ zip: req.body as Buffer }, j.ownerId);
  });
  /** "Send to Jennifer" from the ChatGPT/Claude share sheet (iOS Shortcut) or a paste. */
  /**
   * A long-lived token that can only add clips (for the iOS Share Sheet
   * Shortcut). Creating one is a step-up action; creating a new one revokes the old.
   */
  app.post('/v1/history/clip-token', owner, async (req) => {
    requireSensitive(req);
    const token = `clip_${randomBytes(24).toString('base64url')}`;
    await j.settings.set('history.clipTokenHash', digest(token).toString('hex'));
    j.audit.record(j.ownerId, 'history.clip_token_created', 'clip', {});
    return { token, url: '/v1/history/clip', header: 'X-Jennifer-Clip-Token' };
  });
  const clipAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    const t = req.headers['x-jennifer-clip-token'];
    if (typeof t === 'string' && t) {
      const stored = await j.settings.get<string>('history.clipTokenHash');
      const d = digest(t);
      if (stored && timingSafeEqual(Buffer.from(stored, 'hex'), d)) return;
      return reply.code(401).send({ error: 'unauthorized' });
    }
    return auth('owner')(req, reply);
  };
  app.post('/v1/history/clip', { preHandler: clipAuth }, async (req) => {
    const b = z.object({ text: z.string().min(1).max(500_000), title: z.string().max(200).optional(), from: z.enum(['chatgpt', 'claude', 'other']).optional(), url: z.string().url().max(2000).optional() }).parse(req.body);
    return j.history.clip(b, j.ownerId);
  });
  app.get('/v1/history/search', owner, async (req) => {
    const q = z.object({ q: z.string().min(2).max(200), source: z.enum(['chatgpt', 'claude', 'clip']).optional() }).parse(req.query);
    return j.history.search(q.q, { source: q.source, limit: 30 });
  });
  app.get('/v1/history/conversations', owner, async (req) => {
    const q = z.object({ source: z.enum(['chatgpt', 'claude', 'clip']).optional(), project: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    return j.history.conversations(q);
  });
  app.get('/v1/history/conversations/:id', owner, async (req) => j.history.conversation(z.object({ id: z.string() }).parse(req.params).id));
  app.post('/v1/history/conversations/:id/suggest-memories', owner, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ space: z.enum(SPACES).default('personal') }).parse(req.body ?? {});
    const proposed = await j.history.proposeMemories(id, b.space, j.ownerId);
    return { proposed: proposed.length, pendingReview: proposed.map((m) => ({ id: m.id, value: m.value, kind: m.kind })) };
  });
  app.get('/v1/history/projects', owner, async () => j.history.projects());
  app.get('/v1/history/imports', owner, async () => j.history.imports());
  app.delete('/v1/history/imports/:id', owner, async (req) => {
    await j.history.deleteImport(z.object({ id: z.string() }).parse(req.params).id, j.ownerId);
    return { deleted: true };
  });

  // ---- Audit ---------------------------------------------------------------
  app.get('/v1/audit', anyone, async (req) => {
    const events = j.audit.list();
    // Non-owner roles get redacted diagnostics only.
    return req.role === 'owner' ? events : events.map((e) => ({ id: e.id, at: e.at, actor: e.actor, kind: e.kind }));
  });

  // ---- Phone calls (OpenAI Realtime SIP) ------------------------------------
  /** Signed by OpenAI (Standard Webhooks); no bearer auth. */
  app.post('/v1/webhooks/openai', async (req, reply) => {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as Record<string, string | undefined>;
    try {
      const r = await j.phone.handleWebhook(req.rawBody ?? '', headers);
      return reply.code(200).send(r);
    } catch (e) {
      if (e instanceof JenniferError && e.code.startsWith('webhook.')) return reply.code(401).send({ error: 'bad signature' });
      throw e;
    }
  });
  app.get('/v1/calls', owner, async () => ({ configured: j.phone.configured, calls: await j.phone.log() }));

  // ---- Provider webhooks ---------------------------------------------------
  // ---- SMS to Jennifer's number (Twilio / SignalWire signed webhook) -----------
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.post('/v1/webhooks/sms', async (req, reply) => {
    const cfg = j.config.sms;
    if (!j.sms || !cfg.authToken) return reply.code(503).send({ error: 'sms not configured' });
    const params = (req.body ?? {}) as Record<string, string>;
    const url = `${(j.config.publicUrl ?? '').replace(/\/$/, '')}/v1/webhooks/sms`;
    const sig = (req.headers['x-twilio-signature'] ?? req.headers['x-signalwire-signature']) as string | undefined;
    if (!verifyTwilioSignature(cfg.authToken, url, params, sig)) return reply.code(401).send({ error: 'bad signature' });
    const b = z.object({ MessageSid: z.string(), From: z.string(), To: z.string(), Body: z.string().default('') }).parse(params);
    await j.inbound.handle(
      {
        accountId: j.sms.accountId,
        connectorId: 'sms',
        providerMessageId: b.MessageSid,
        providerThreadId: `sms:${b.From}`,
        from: { address: b.From },
        to: [b.To],
        cc: [],
        subject: '',
        body: b.Body,
        headers: {},
        occurredAt: j.clock.now(),
        space: 'personal',
        channel: 'sms',
      },
      { autoDraft: true },
    );
    j.capabilities.recordSync('sms');
    return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  // ---- WhatsApp Business (Meta Cloud API webhook) -------------------------------
  /** Meta's one-time verification handshake when the webhook is registered. */
  app.get('/v1/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const expected = j.config.whatsapp.verifyToken;
    if (!expected || q['hub.mode'] !== 'subscribe' || !q['hub.verify_token'] || !verifyWebhookToken(expected, q['hub.verify_token'])) return reply.code(403).send('forbidden');
    return reply.type('text/plain').send(q['hub.challenge'] ?? '');
  });
  app.post('/v1/webhooks/whatsapp', async (req, reply) => {
    const wa = j.whatsapp;
    if (!wa || !j.config.whatsapp.appSecret) return reply.code(503).send({ error: 'whatsapp not configured' });
    if (!verifyMetaSignature(j.config.whatsapp.appSecret, req.rawBody ?? '', req.headers['x-hub-signature-256'] as string | undefined)) return reply.code(401).send({ error: 'bad signature' });
    const body = req.body as { entry?: Array<{ changes?: Array<{ field?: string; value?: WhatsAppWebhookValue }> }> };
    const space = j.config.whatsapp.space;
    for (const change of (body.entry ?? []).flatMap((e) => e.changes ?? [])) {
      const v = change.value ?? {};
      for (const st of v.statuses ?? []) wa.noteStatus(st.biz_opaque_callback_data, st.id);
      const names = new Map((v.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages ?? []) {
        const from = toE164(m.from);
        const at = Number(m.timestamp) * 1000 || j.clock.now().getTime();
        wa.noteInbound(from, at);
        const text = m.type === 'text' ? (m.text?.body ?? '') : `[${m.type} message]`;
        await j.inbound.handle(
          { accountId: wa.accountId, connectorId: 'whatsapp_business', providerMessageId: m.id, providerThreadId: `whatsapp:${from}`, from: { displayName: names.get(m.from), address: from }, to: [v.metadata?.display_phone_number ?? 'me'], cc: [], subject: '', body: text, headers: {}, occurredAt: new Date(at), space, channel: 'whatsapp' },
          { autoDraft: m.type === 'text' },
        );
      }
      // Coexistence: what Bruno typed in the WhatsApp Business app.
      for (const e of v.message_echoes ?? []) {
        const to = toE164(e.to);
        j.inbound.handleSent({ accountId: wa.accountId, connectorId: 'whatsapp_business', providerMessageId: e.id, providerThreadId: `whatsapp:${to}`, from: { displayName: 'Bruno', address: 'me' }, to: [to], cc: [], subject: '', body: e.text?.body ?? `[${e.type}]`, headers: {}, occurredAt: new Date(Number(e.timestamp) * 1000 || j.clock.now().getTime()), space, channel: 'whatsapp' });
      }
    }
    j.capabilities.recordSync('whatsapp_business');
    return { ok: true };
  });

  // ---- iMessage / SMS from Bruno's Mac (BlueBubbles Server webhook) ----------
  app.post('/v1/webhooks/imessage', async (req, reply) => {
    const cfg = j.config.imessage;
    if (!j.imessage || !cfg.webhookToken) return reply.code(503).send({ error: 'imessage not configured' });
    if (!verifyWebhookToken(cfg.webhookToken, (req.query as { token?: string }).token)) return reply.code(401).send({ error: 'bad token' });
    const ev = z.object({ type: z.string(), data: z.any() }).parse(req.body);
    if (ev.type !== 'new-message' || !ev.data) return { ignored: ev.type };
    const m = ev.data as BlueBubblesMessage;
    const chat = m.chats?.[0];
    const text = (m.text ?? '').trim();
    if (!chat || !text) return { ignored: 'no text' };
    const group = chat.guid.includes(';+;');
    const counterpart = m.handle?.address ?? chat.guid.split(';-;')[1] ?? 'unknown';
    const base = {
      accountId: j.imessage.accountId,
      connectorId: 'imessage',
      providerMessageId: m.guid,
      providerThreadId: `imessage:${chat.guid}`,
      cc: [],
      subject: chat.displayName ?? '',
      body: text,
      headers: {},
      occurredAt: new Date(m.dateCreated || j.clock.now().getTime()),
      space: 'personal' as const,
      channel: 'imessage' as const,
    };
    if (m.isFromMe) {
      // Jennifer's own sends echo back from the Mac; anything else is Bruno typing on his phone or Mac.
      if (j.imessage.isOwnEcho(chat.guid, text)) return { own: true };
      return j.inbound.handleSent({ ...base, from: { displayName: 'Bruno', address: 'me' }, to: [counterpart] });
    }
    // Group chats are kept for context; Jennifer drafts only in one-to-one chats.
    const r = await j.inbound.handle({ ...base, from: { address: counterpart }, to: ['me'] }, { autoDraft: !group });
    j.capabilities.recordSync('imessage');
    return { received: true, drafted: !!r.proposedActionId };
  });

  app.post('/v1/webhooks/email/:connectorId', async (req, reply) => {
    if (!opts.webhookSecret) return reply.code(503).send({ error: 'webhooks not configured' });
    try {
      verifyWebhookSignature({
        secret: opts.webhookSecret,
        body: req.rawBody ?? '',
        timestamp: String(req.headers['x-jennifer-timestamp'] ?? ''),
        signature: String(req.headers['x-jennifer-signature'] ?? ''),
        now: j.clock.now(),
      });
    } catch {
      return reply.code(401).send({ error: 'bad signature' });
    }
    const { connectorId } = z.object({ connectorId: z.string() }).parse(req.params);
    const b = z
      .object({
        accountId: z.string(),
        providerMessageId: z.string(),
        providerThreadId: z.string(),
        from: z.object({ displayName: z.string().optional(), address: z.string() }),
        to: z.array(z.string()).default([]),
        cc: z.array(z.string()).default([]),
        subject: z.string().default(''),
        body: z.string(),
        headers: z.record(z.string(), z.string()).default({}),
        occurredAt: z.coerce.date(),
        space: z.enum(SPACES),
      })
      .parse(req.body);
    const email = { ...b, connectorId };
    // Commit before acknowledging; process asynchronously.
    const { event, duplicate } = await j.inbound.receive(email);
    if (!duplicate) setImmediate(() => void j.inbound.process(event, email, { autoDraft: true }).catch((e) => app.log.error(redactSecrets(String(e)))));
    return reply.code(202).send({ eventId: event.eventId, duplicate });
  });

  return app;
}

function approvalCard(a: ReturnType<Jennifer['actions']['get']>) {
  const p = a.payload as Record<string, unknown>;
  return {
    id: a.id,
    type: a.type,
    channel: a.channel,
    state: a.state,
    reason: a.stateReason,
    revision: a.revision,
    payloadHash: a.payloadHash,
    sendingAccount: a.accountId,
    recipients: [...((p.to as string[]) ?? []), ...((p.cc as string[]) ?? []), ...((p.bcc as string[]) ?? [])],
    subject: p.subject,
    body: p.body,
    attachmentIds: p.attachmentIds ?? [],
    consequences: a.decisionReasons,
    expiresAt: a.expiresAt,
  };
}
