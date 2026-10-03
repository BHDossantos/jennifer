import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { ACTION_MODES, ACTION_TYPES, JenniferError, SPACES } from '../core/types.js';
import type { Jennifer } from '../app.js';
import { verifyWebhookSignature } from '../events/events.js';
import { redactSecrets } from '../security/redaction.js';
import { DASHBOARD_HTML } from './dashboard.js';
import type { IdentityService, Session } from '../identity/identity.js';
import type { GmailService } from '../connectors/gmail/service.js';
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
  app.get('/', async (_req, reply) => reply.type('text/html').send(DASHBOARD_HTML));

  // ---- Today / Connections ------------------------------------------------
  app.get('/v1/today', owner, async () => ({
    brief: j.dailyBrief(),
    awaitingDecision: j.actions.list({ state: 'awaiting_decision' }).map(approvalCard),
    controls: j.controls.status(),
    activity: j.agents.activityFeed().slice(-20),
  }));
  app.get('/v1/connections', anyone, async () => j.capabilities.screen());
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
    return { ...approvalCard(a), history: a.history, receipt: a.receipt };
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
    return { canceled: j.actions.cancel(id, j.ownerId, 'canceled by Bruno') };
  });

  // ---- Identity: passkeys, step-up, devices ---------------------------------
  const DeviceInfo = z.object({ platform: z.string().max(40), osVersion: z.string().max(40).optional(), label: z.string().max(80).optional() });
  app.post('/v1/auth/passkeys/register/options', owner, async () => requireIdentity().registrationOptions(j.ownerId, j.ownerId));
  app.post('/v1/auth/passkeys/register/verify', owner, async (req) => {
    const b = z.object({ handle: z.string(), response: z.any(), device: DeviceInfo }).parse(req.body);
    return requireIdentity().verifyRegistration(b.handle, b.response, b.device);
  });
  app.post('/v1/auth/passkeys/login/options', async () => requireIdentity().loginOptions(j.ownerId));
  app.post('/v1/auth/passkeys/login/verify', async (req) => {
    const b = z.object({ handle: z.string(), response: z.any() }).parse(req.body);
    const { token, session } = await requireIdentity().verifyLogin(b.handle, b.response);
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
    await requireIdentity().revokeDevice(j.ownerId, z.object({ id: z.string() }).parse(req.params).id, j.ownerId);
    return { revoked: true };
  });

  // ---- Connectors: Gmail ----------------------------------------------------
  /** Connecting accounts is security-sensitive: passkey step-up, or the bootstrap token in development only. */
  const requireSensitive = (req: FastifyRequest) => {
    if (req.session) {
      if (!opts.identity?.hasRecentStepUp(req.session)) throw new JenniferError('approval.step_up_required', 'Confirm with your passkey first');
      return;
    }
    if (j.config.env !== 'development') throw new JenniferError('identity.session_required', 'Sign in with a passkey to connect accounts');
  };
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

  // ---- Authority registry --------------------------------------------------
  app.get('/v1/authority', owner, async () => j.authority.list());
  app.post('/v1/authority', owner, async (req) => {
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
  app.post('/v1/memory/import/chatgpt', owner, async (req) => {
    const b = z.object({ export: z.string(), conversationIds: z.array(z.string()).optional() }).parse(req.body);
    return j.importer.importExport(j.ownerId, b.export, b.conversationIds);
  });

  // ---- Audit ---------------------------------------------------------------
  app.get('/v1/audit', anyone, async (req) => {
    const events = j.audit.list();
    // Non-owner roles get redacted diagnostics only.
    return req.role === 'owner' ? events : events.map((e) => ({ id: e.id, at: e.at, actor: e.actor, kind: e.kind }));
  });

  // ---- Provider webhooks ---------------------------------------------------
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
