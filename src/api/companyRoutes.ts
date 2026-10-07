import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { JenniferError } from '../core/types.js';
import { textModel } from '../core/config.js';
import type { Jennifer } from '../app.js';
import { ROLE_CATALOG } from '../company/catalog.js';
import { roleStatus, roleVersion } from '../company/roles.js';
import { CompanyOS } from '../company/engine.js';
import type { CompanyId } from '../company/model.js';

/**
 * Company OS API (blueprint §13). Every route derives the actor from the
 * authenticated session and checks company membership before touching
 * data; a company the actor cannot see answers "not found".
 */
export function registerCompanyRoutes(app: FastifyInstance, j: Jennifer, owner: { preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> }) {
  const actor = (_req: FastifyRequest) => j.ownerId; // single-owner deployment; memberships still enforced
  const Cid = z.object({ cid: z.string() });
  const cidOf = async (req: FastifyRequest, perm: 'read' | 'run' | 'review' | 'admin' = 'read') => {
    const { cid } = Cid.parse(req.params);
    await j.company.access(actor(req), cid, perm);
    return cid as CompanyId;
  };

  app.get('/v1/companies', owner, async (req) => {
    const list = await j.company.companiesFor(actor(req));
    return Promise.all(
      list.map(async (c) => ({
        ...c,
        pending: {
          approvals: j.actions.list({ ownerId: j.ownerId, state: 'awaiting_decision' }).filter((a) => a.space === c.id).length,
          crmChanges: (await j.companyRepo.patches(c.id, 'proposed')).length,
          drafts: (await j.companyRepo.artifacts(c.id)).filter((a) => a.review === 'pending' && a.kind === 'email_draft').length,
        },
      })),
    );
  });
  app.put('/v1/companies/:cid/profile', owner, async (req) => {
    const cid = await cidOf(req, 'admin');
    const b = z.record(z.string().max(60), z.unknown()).parse(req.body);
    return j.company.updateProfile(actor(req), cid, b);
  });
  app.put('/v1/companies/:cid/name', owner, async (req) => {
    const cid = await cidOf(req, 'admin');
    return j.company.rename(actor(req), cid, z.object({ name: z.string().min(1).max(80) }).parse(req.body).name);
  });
  /** Company-scoped emergency stop: no new runs or side effects; open runs are cancelled. */
  app.post('/v1/companies/:cid/status', owner, async (req) => {
    const cid = await cidOf(req, 'admin');
    const b = z.object({ status: z.enum(['active', 'paused']) }).parse(req.body);
    return j.company.setStatus(actor(req), cid, b.status);
  });

  // ---- Organization map and directory -----------------------------------------
  const env = async (cid: CompanyId) => ({
    modelConfigured: j.company.d.executor.available,
    webConfigured: textModel(j.config).provider !== 'none',
    approvedCategories: await j.companyBrain.approvedCategories(cid),
    emailConnected: !!j.capabilities.get('gmail')?.connected,
    paused: (await j.company.access(j.ownerId, cid)).company.status === 'paused',
  });
  app.get('/v1/companies/:cid/map', owner, async (req) => {
    const cid = await cidOf(req);
    const e = await env(cid);
    const roles = ROLE_CATALOG.map((r) => roleStatus(r, e));
    const runs = await j.company.listRuns(actor(req), cid, 100);
    const active = runs.filter((r) => r.status === 'queued' || r.status === 'running');
    return {
      coordinator: { name: 'Jennifer', activeRuns: active.length },
      departments: Object.entries(CompanyOS.departments()).map(([id, d]) => ({
        id,
        ...d,
        ready: roles.filter((r) => r.department === id && r.readiness === 'ready').length,
        needsSetup: roles.filter((r) => r.department === id && r.readiness === 'needs_setup').length,
      })),
      totals: { roles: roles.length, ready: roles.filter((r) => r.readiness === 'ready').length, needsSetup: roles.filter((r) => r.readiness === 'needs_setup').length, designOnly: roles.filter((r) => r.readiness === 'design_only').length },
    };
  });
  app.get('/v1/companies/:cid/roles', owner, async (req) => {
    const cid = await cidOf(req);
    const q = z.object({ q: z.string().optional(), department: z.string().optional(), readiness: z.string().optional(), phase: z.coerce.number().optional() }).parse(req.query);
    const e = await env(cid);
    const needle = q.q?.toLowerCase();
    return ROLE_CATALOG.filter((r) => (!q.department || r.department === q.department) && (!q.phase || r.phase === q.phase) && (!needle || `${r.id} ${r.name} ${r.responsibility} ${r.deliverable}`.toLowerCase().includes(needle)))
      .map((r) => ({ ...r, ...roleStatus(r, e) }))
      .filter((r) => !q.readiness || r.readiness === q.readiness);
  });
  app.get('/v1/companies/:cid/roles/:rid', owner, async (req) => {
    const cid = await cidOf(req);
    const { rid } = z.object({ rid: z.string() }).parse(req.params);
    const rec = ROLE_CATALOG.find((r) => r.id === rid);
    if (!rec) throw new JenniferError('role.not_found', 'Not found');
    const v = roleVersion(rid);
    const runs = (await j.company.listRuns(actor(req), cid, 200)).filter((r) => r.steps.some((s) => s.roleId === rid));
    return { ...rec, ...roleStatus(rec, await env(cid)), configuration: v ?? null, history: runs.slice(0, 20).map((r) => ({ runId: r.id, workflowId: r.workflowId, status: r.status, at: r.createdAt })) };
  });
  app.get('/v1/workflows', owner, async () => j.company.workflowList());

  // ---- Runs -----------------------------------------------------------------------
  app.post('/v1/companies/:cid/runs', owner, async (req, reply) => {
    const cid = await cidOf(req, 'run');
    const b = z.object({ workflowId: z.string(), input: z.record(z.string(), z.unknown()).default({}), budgetEur: z.number().positive().max(25).optional() }).parse(req.body);
    const key = req.headers['idempotency-key'];
    const run = await j.company.createRun(actor(req), cid, b.workflowId, b.input, { idempotencyKey: typeof key === 'string' && key ? key.slice(0, 200) : undefined, budgetEur: b.budgetEur });
    return reply.code(202).send(run);
  });
  app.get('/v1/companies/:cid/runs', owner, async (req) => j.company.listRuns(actor(req), await cidOf(req), 100));
  app.get('/v1/companies/:cid/runs/:rid', owner, async (req) => {
    const cid = await cidOf(req);
    const { rid } = z.object({ rid: z.string() }).parse(req.params);
    const run = await j.company.getRun(actor(req), cid, rid);
    return { ...run, artifacts: await j.companyRepo.artifacts(cid, rid) };
  });
  app.post('/v1/companies/:cid/runs/:rid/cancel', owner, async (req) => {
    const cid = await cidOf(req, 'run');
    return j.company.cancel(actor(req), cid, z.object({ rid: z.string() }).parse(req.params).rid);
  });
  /** Ordered persisted events; Server-Sent Events when asked, resuming after Last-Event-ID. */
  app.get('/v1/companies/:cid/runs/:rid/events', owner, async (req, reply) => {
    const cid = await cidOf(req);
    const { rid } = z.object({ rid: z.string() }).parse(req.params);
    const after = Number(req.headers['last-event-id'] ?? (req.query as { after?: string }).after ?? 0) || 0;
    const past = await j.company.events(actor(req), cid, rid, after);
    if (!String(req.headers.accept ?? '').includes('text/event-stream')) return past;
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (e: { seq: number; type: string; data: unknown; at: string }) => reply.raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e })}\n\n`);
    let last = after;
    for (const e of past) (send(e), (last = e.seq));
    const off = j.company.subscribe(cid, rid, (e) => {
      if (e.seq > last) (send(e), (last = e.seq));
    });
    const ping = setInterval(() => reply.raw.write(': keep-alive\n\n'), 20_000);
    req.raw.on('close', () => (off(), clearInterval(ping)));
    return reply;
  });

  // ---- Artifacts and approval queue ---------------------------------------------------
  app.get('/v1/companies/:cid/artifacts', owner, async (req) => {
    const cid = await cidOf(req);
    const q = z.object({ runId: z.string().optional(), review: z.string().optional() }).parse(req.query);
    return (await j.companyRepo.artifacts(cid, q.runId)).filter((a) => !q.review || a.review === q.review);
  });
  app.post('/v1/companies/:cid/artifacts/:aid/review', owner, async (req) => {
    const cid = await cidOf(req, 'review');
    const { aid } = z.object({ aid: z.string() }).parse(req.params);
    const b = z.object({ decision: z.enum(['approved', 'rejected']), edits: z.object({ subject: z.string().max(300).optional(), body: z.string().max(20_000).optional() }).optional() }).parse(req.body);
    const repo = j.companyRepo;
    const a = await repo.artifact(cid, aid);
    if (!a) throw new JenniferError('artifact.not_found', 'Not found');
    if (b.edits && a.kind === 'email_draft') a.content = { ...(a.content as object), ...b.edits };
    a.review = b.decision;
    await repo.saveArtifact(a);
    j.audit.record(actor(req), `company.artifact_${b.decision}`, aid, { companyId: cid, kind: a.kind });
    return a;
  });
  /**
   * An approved first-contact draft becomes an exact send proposal that waits
   * for Bruno's approval (never sent automatically: Jennifer only replies on
   * her own). Requires a connected sending account.
   */
  app.post('/v1/companies/:cid/artifacts/:aid/prepare-send', owner, async (req) => {
    const cid = await cidOf(req, 'review');
    const { aid } = z.object({ aid: z.string() }).parse(req.params);
    const a = await j.companyRepo.artifact(cid, aid);
    if (!a || a.kind !== 'email_draft') throw new JenniferError('artifact.not_found', 'Not found');
    if (a.review !== 'approved') throw new JenniferError('artifact.not_approved', 'Approve the draft first');
    const g = j.capabilities.get('gmail');
    if (!g?.connected || !g.accountId) throw new JenniferError('artifact.no_sender', 'Connect Gmail to send');
    const c = a.content as { to: string; subject: string; body: string; flags?: string[] };
    const intent = j.actions.propose({ ownerId: j.ownerId, type: 'send_message', space: cid, channel: 'email', connectorId: 'gmail', accountId: g.accountId, payload: { to: [c.to], cc: [], bcc: [], subject: c.subject, body: c.body, attachmentIds: [], evidence: [] }, proposedBy: `company:${cid}:${a.runId ?? 'manual'}` });
    j.actions.requireDecision(intent.id, j.ownerId, 'first contact from a Company OS draft');
    return { actionId: intent.id, state: j.actions.get(intent.id).state };
  });
  app.get('/v1/companies/:cid/approvals', owner, async (req) => {
    const cid = await cidOf(req);
    const repo = j.companyRepo;
    return {
      actions: j.actions.list({ ownerId: j.ownerId, state: 'awaiting_decision' }).filter((a) => a.space === cid).map((a) => ({ id: a.id, type: a.type, revision: a.revision, payloadHash: a.payloadHash, payload: a.payload, reasons: a.decisionReasons, expiresAt: a.expiresAt })),
      drafts: (await repo.artifacts(cid)).filter((a) => a.review === 'pending' && ['email_draft', 'proposed_icp'].includes(a.kind)),
      crmChanges: await repo.patches(cid, 'proposed'),
      knowledge: (await repo.sources(cid)).filter((s) => s.status === 'pending_review'),
    };
  });

  // ---- Company brain ---------------------------------------------------------------
  app.get('/v1/companies/:cid/knowledge/sources', owner, async (req) => j.companyRepo.sources(await cidOf(req)));
  app.post('/v1/companies/:cid/knowledge/sources', owner, async (req, reply) => {
    const cid = await cidOf(req, 'admin');
    const b = z
      .object({
        title: z.string().min(2).max(200),
        category: z.string().min(2).max(40),
        classification: z.enum(['public', 'internal', 'confidential', 'restricted']).default('internal'),
        text: z.string().max(500_000).optional(),
        url: z.string().url().max(2000).optional(),
        effectiveAt: z.string().optional(),
        expiresAt: z.string().optional(),
        reviewDueAt: z.string().optional(),
      })
      .refine((x) => x.text || x.url, 'text or url is required')
      .parse(req.body);
    return reply.code(202).send(await j.companyBrain.addSource(cid, b, actor(req)));
  });
  app.post('/v1/companies/:cid/knowledge/sources/:sid/review', owner, async (req) => {
    const cid = await cidOf(req, 'admin');
    const { sid } = z.object({ sid: z.string() }).parse(req.params);
    const b = z.object({ decision: z.enum(['approved', 'revoked']) }).parse(req.body);
    return j.companyBrain.review(cid, sid, b.decision, actor(req));
  });
  app.post('/v1/companies/:cid/knowledge/search', owner, async (req) => {
    const cid = await cidOf(req);
    const b = z.object({ query: z.string().min(2).max(300), purpose: z.string().max(100).optional(), categories: z.array(z.string()).optional() }).parse(req.body);
    return j.companyBrain.search(cid, b.query, { categories: b.categories, limit: 10 });
  });

  // ---- CRM ---------------------------------------------------------------------------
  app.get('/v1/companies/:cid/crm', owner, async (req) => {
    const cid = await cidOf(req);
    const q = z.object({ kind: z.enum(['account', 'contact', 'opportunity', 'task']).optional() }).parse(req.query);
    return j.companyCrm.records(cid, q.kind);
  });
  app.post('/v1/companies/:cid/crm/records', owner, async (req) => {
    const cid = await cidOf(req, 'review');
    const b = z.object({ kind: z.enum(['account', 'contact', 'opportunity', 'task']), fields: z.record(z.string(), z.unknown()) }).parse(req.body);
    const p = await j.companyCrm.propose(cid, { kind: b.kind, changes: Object.fromEntries(Object.entries(b.fields).map(([k, v]) => [k, { to: v, source: 'entered by Bruno' }])), reason: 'Entered by Bruno' });
    return (await j.companyCrm.decide(cid, p.id, 'apply', actor(req))).record;
  });
  app.post('/v1/companies/:cid/crm/patches/:pid', owner, async (req) => {
    const cid = await cidOf(req, 'review');
    const { pid } = z.object({ pid: z.string() }).parse(req.params);
    const b = z.object({ decision: z.enum(['apply', 'reject']) }).parse(req.body);
    return j.companyCrm.decide(cid, pid, b.decision, actor(req));
  });
}
