import type { Db } from '../db/db.js';
import type { Artifact, Company, CompanyId, CrmPatch, CrmRecord, KnowledgeChunk, KnowledgeFact, KnowledgeSource, Membership, Run, RunEvent, RunStatus } from './model.js';

/**
 * Company OS persistence. Every method takes the company id explicitly and
 * every query filters by it: there is no "get by id" that crosses companies.
 */
export interface CompanyRepo {
  saveCompany(c: Company, ownerId: string): Promise<void>;
  companies(): Promise<Company[]>;
  saveMembership(m: Membership): Promise<void>;
  memberships(userId: string): Promise<Membership[]>;

  saveRun(r: Run): Promise<void>;
  run(companyId: CompanyId, id: string): Promise<Run | undefined>;
  runByKey(companyId: CompanyId, key: string): Promise<Run | undefined>;
  runs(companyId: CompanyId, limit: number): Promise<Run[]>;
  runsWithStatus(statuses: RunStatus[]): Promise<Run[]>;
  appendEvent(e: RunEvent): Promise<void>;
  events(companyId: CompanyId, runId: string, afterSeq: number): Promise<RunEvent[]>;

  saveArtifact(a: Artifact): Promise<void>;
  artifact(companyId: CompanyId, id: string): Promise<Artifact | undefined>;
  artifacts(companyId: CompanyId, runId?: string): Promise<Artifact[]>;

  saveSource(s: KnowledgeSource): Promise<void>;
  source(companyId: CompanyId, id: string): Promise<KnowledgeSource | undefined>;
  sources(companyId: CompanyId): Promise<KnowledgeSource[]>;
  replaceChunks(companyId: CompanyId, sourceId: string, chunks: KnowledgeChunk[]): Promise<void>;
  /** Lexical search over approved, unexpired chunks of allowed categories in ONE company. */
  searchChunks(companyId: CompanyId, query: string, opts: { categories?: string[]; limit: number; now: Date }): Promise<Array<KnowledgeChunk & { title: string; score: number }>>;
  saveFact(f: KnowledgeFact): Promise<void>;
  facts(companyId: CompanyId): Promise<KnowledgeFact[]>;

  saveRecord(r: CrmRecord): Promise<void>;
  record(companyId: CompanyId, id: string): Promise<CrmRecord | undefined>;
  records(companyId: CompanyId, kind?: string): Promise<CrmRecord[]>;
  savePatch(p: CrmPatch): Promise<void>;
  patch(companyId: CompanyId, id: string): Promise<CrmPatch | undefined>;
  patches(companyId: CompanyId, status?: string): Promise<CrmPatch[]>;
}

export const terms = (q: string) =>
  q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 2);

const usable = (s: KnowledgeSource | undefined, now: Date, categories?: string[]) =>
  !!s && s.status === 'approved' && (!s.expiresAt || Date.parse(s.expiresAt) > now.getTime()) && (!categories || categories.includes(s.category));

const clone = <T>(x: T): T => structuredClone(x);

export class MemoryCompanyRepo implements CompanyRepo {
  private c = new Map<string, Company>();
  private m: Membership[] = [];
  private r = new Map<string, Run>();
  private ev = new Map<string, RunEvent[]>();
  private a = new Map<string, Artifact>();
  private s = new Map<string, KnowledgeSource>();
  private ch = new Map<string, KnowledgeChunk[]>();
  private f = new Map<string, KnowledgeFact>();
  private rec = new Map<string, CrmRecord>();
  private p = new Map<string, CrmPatch>();
  private k = (companyId: string, id: string) => `${companyId}\u0000${id}`;

  async saveCompany(c: Company) {
    this.c.set(c.id, clone(c));
  }
  async companies() {
    return [...this.c.values()].map(clone);
  }
  async saveMembership(m: Membership) {
    this.m = this.m.filter((x) => !(x.companyId === m.companyId && x.userId === m.userId));
    this.m.push(clone(m));
  }
  async memberships(userId: string) {
    return this.m.filter((x) => x.userId === userId).map(clone);
  }
  async saveRun(r: Run) {
    if (r.idempotencyKey) {
      const dup = [...this.r.values()].find((x) => x.companyId === r.companyId && x.idempotencyKey === r.idempotencyKey && x.id !== r.id);
      if (dup) throw Object.assign(new Error('duplicate idempotency key'), { code: 'run.duplicate_key' });
    }
    this.r.set(this.k(r.companyId, r.id), clone(r));
  }
  async run(companyId: CompanyId, id: string) {
    const r = this.r.get(this.k(companyId, id));
    return r && clone(r);
  }
  async runByKey(companyId: CompanyId, key: string) {
    const r = [...this.r.values()].find((x) => x.companyId === companyId && x.idempotencyKey === key);
    return r && clone(r);
  }
  async runs(companyId: CompanyId, limit: number) {
    return [...this.r.values()].filter((x) => x.companyId === companyId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(clone);
  }
  async runsWithStatus(statuses: RunStatus[]) {
    return [...this.r.values()].filter((x) => statuses.includes(x.status)).map(clone);
  }
  async appendEvent(e: RunEvent) {
    const key = this.k(e.companyId, e.runId);
    const list = this.ev.get(key) ?? [];
    if (list.some((x) => x.seq === e.seq)) throw Object.assign(new Error('duplicate event sequence'), { code: 'run.event_conflict' });
    list.push(clone(e));
    this.ev.set(key, list);
  }
  async events(companyId: CompanyId, runId: string, afterSeq: number) {
    return (this.ev.get(this.k(companyId, runId)) ?? []).filter((e) => e.seq > afterSeq).sort((a, b) => a.seq - b.seq).map(clone);
  }
  async saveArtifact(a: Artifact) {
    this.a.set(this.k(a.companyId, a.id), clone(a));
  }
  async artifact(companyId: CompanyId, id: string) {
    const a = this.a.get(this.k(companyId, id));
    return a && clone(a);
  }
  async artifacts(companyId: CompanyId, runId?: string) {
    return [...this.a.values()].filter((a) => a.companyId === companyId && (!runId || a.runId === runId)).map(clone);
  }
  async saveSource(s: KnowledgeSource) {
    this.s.set(this.k(s.companyId, s.id), clone(s));
  }
  async source(companyId: CompanyId, id: string) {
    const s = this.s.get(this.k(companyId, id));
    return s && clone(s);
  }
  async sources(companyId: CompanyId) {
    return [...this.s.values()].filter((s) => s.companyId === companyId).map(clone);
  }
  async replaceChunks(companyId: CompanyId, sourceId: string, chunks: KnowledgeChunk[]) {
    this.ch.set(this.k(companyId, sourceId), chunks.map(clone));
  }
  async searchChunks(companyId: CompanyId, query: string, opts: { categories?: string[]; limit: number; now: Date }) {
    const t = terms(query);
    if (!t.length) return [];
    const out: Array<KnowledgeChunk & { title: string; score: number }> = [];
    for (const [key, chunks] of this.ch) {
      if (!key.startsWith(`${companyId}\u0000`)) continue;
      const src = this.s.get(key);
      if (!usable(src, opts.now, opts.categories)) continue;
      for (const c of chunks) {
        const lower = c.text.toLowerCase();
        const score = t.filter((x) => lower.includes(x)).length;
        if (score) out.push({ ...clone(c), title: src!.title, score });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, opts.limit);
  }
  async saveFact(f: KnowledgeFact) {
    this.f.set(this.k(f.companyId, f.id), clone(f));
  }
  async facts(companyId: CompanyId) {
    return [...this.f.values()].filter((f) => f.companyId === companyId).map(clone);
  }
  async saveRecord(r: CrmRecord) {
    this.rec.set(this.k(r.companyId, r.id), clone(r));
  }
  async record(companyId: CompanyId, id: string) {
    const r = this.rec.get(this.k(companyId, id));
    return r && clone(r);
  }
  async records(companyId: CompanyId, kind?: string) {
    return [...this.rec.values()].filter((r) => r.companyId === companyId && (!kind || r.kind === kind)).map(clone);
  }
  async savePatch(p: CrmPatch) {
    this.p.set(this.k(p.companyId, p.id), clone(p));
  }
  async patch(companyId: CompanyId, id: string) {
    const p = this.p.get(this.k(companyId, id));
    return p && clone(p);
  }
  async patches(companyId: CompanyId, status?: string) {
    return [...this.p.values()].filter((p) => p.companyId === companyId && (!status || p.status === status)).map(clone);
  }
}

const j = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

export class PgCompanyRepo implements CompanyRepo {
  constructor(private db: Db) {}

  async saveCompany(c: Company, ownerId: string) {
    await this.db.query(
      `INSERT INTO company (id, owner_id, name, timezone, locale, status, profile) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone, locale = EXCLUDED.locale, status = EXCLUDED.status, profile = EXCLUDED.profile`,
      [c.id, ownerId, c.name, c.timezone, c.locale, c.status, JSON.stringify(c.profile)],
    );
  }
  async companies() {
    const r = await this.db.query<Record<string, any>>('SELECT * FROM company ORDER BY id');
    return r.rows.map((x) => ({ id: x.id, name: x.name, timezone: x.timezone, locale: x.locale, status: x.status, profile: j(x.profile) }) as Company);
  }
  async saveMembership(m: Membership) {
    await this.db.query(
      `INSERT INTO company_membership (company_id, user_id, role, permissions, revoked_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, revoked_at = EXCLUDED.revoked_at`,
      [m.companyId, m.userId, m.role, m.permissions, m.revokedAt ?? null],
    );
  }
  async memberships(userId: string) {
    const r = await this.db.query<Record<string, any>>('SELECT * FROM company_membership WHERE user_id = $1', [userId]);
    return r.rows.map((x) => ({
      companyId: x.company_id,
      userId: x.user_id,
      role: x.role,
      permissions: typeof x.permissions === 'string' ? x.permissions.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : (x.permissions ?? []),
      revokedAt: x.revoked_at ? new Date(x.revoked_at).toISOString() : undefined,
    }));
  }

  async saveRun(r: Run) {
    try {
      await this.db.query(
        `INSERT INTO company_run (company_id, id, workflow_id, workflow_version, status, idempotency_key, data, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (company_id, id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [r.companyId, r.id, r.workflowId, r.workflowVersion, r.status, r.idempotencyKey ?? null, JSON.stringify(r), r.createdAt, r.updatedAt],
      );
    } catch (e) {
      if (/company_run_idem|duplicate key/.test((e as Error).message)) throw Object.assign(new Error('duplicate idempotency key'), { code: 'run.duplicate_key' });
      throw e;
    }
  }
  async run(companyId: CompanyId, id: string) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM company_run WHERE company_id = $1 AND id = $2', [companyId, id]);
    return r.rows[0] ? (j(r.rows[0].data) as Run) : undefined;
  }
  async runByKey(companyId: CompanyId, key: string) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM company_run WHERE company_id = $1 AND idempotency_key = $2', [companyId, key]);
    return r.rows[0] ? (j(r.rows[0].data) as Run) : undefined;
  }
  async runs(companyId: CompanyId, limit: number) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM company_run WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2', [companyId, limit]);
    return r.rows.map((x) => j(x.data) as Run);
  }
  async runsWithStatus(statuses: RunStatus[]) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM company_run WHERE status = ANY($1::text[]) ORDER BY updated_at', [statuses]);
    return r.rows.map((x) => j(x.data) as Run);
  }
  async appendEvent(e: RunEvent) {
    try {
      await this.db.query('INSERT INTO company_run_event (company_id, run_id, seq, type, at, data) VALUES ($1,$2,$3,$4,$5,$6)', [e.companyId, e.runId, e.seq, e.type, e.at, JSON.stringify(e.data)]);
    } catch (err) {
      if (/duplicate key|unique/i.test((err as Error).message)) throw Object.assign(new Error('duplicate event sequence'), { code: 'run.event_conflict' });
      throw err;
    }
  }
  async events(companyId: CompanyId, runId: string, afterSeq: number) {
    const r = await this.db.query<Record<string, any>>('SELECT * FROM company_run_event WHERE company_id = $1 AND run_id = $2 AND seq > $3 ORDER BY seq', [companyId, runId, afterSeq]);
    return r.rows.map((x) => ({ companyId: x.company_id, runId: x.run_id, seq: Number(x.seq), type: x.type, at: new Date(x.at).toISOString(), data: j(x.data) }));
  }

  async saveArtifact(a: Artifact) {
    await this.db.query(
      `INSERT INTO company_artifact (company_id, id, run_id, kind, content_hash, review, data) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id, id) DO UPDATE SET review = EXCLUDED.review, data = EXCLUDED.data`,
      [a.companyId, a.id, a.runId ?? null, a.kind, a.contentHash, a.review, JSON.stringify(a)],
    );
  }
  async artifact(companyId: CompanyId, id: string) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM company_artifact WHERE company_id = $1 AND id = $2', [companyId, id]);
    return r.rows[0] ? (j(r.rows[0].data) as Artifact) : undefined;
  }
  async artifacts(companyId: CompanyId, runId?: string) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM company_artifact WHERE company_id = $1 AND ($2::text IS NULL OR run_id = $2) ORDER BY created_at DESC', [companyId, runId ?? null]);
    return r.rows.map((x) => j(x.data) as Artifact);
  }

  async saveSource(s: KnowledgeSource) {
    await this.db.query(
      `INSERT INTO knowledge_source (company_id, id, title, classification, status, data) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id, id) DO UPDATE SET title = EXCLUDED.title, classification = EXCLUDED.classification, status = EXCLUDED.status, data = EXCLUDED.data`,
      [s.companyId, s.id, s.title, s.classification, s.status, JSON.stringify(s)],
    );
  }
  async source(companyId: CompanyId, id: string) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM knowledge_source WHERE company_id = $1 AND id = $2', [companyId, id]);
    return r.rows[0] ? (j(r.rows[0].data) as KnowledgeSource) : undefined;
  }
  async sources(companyId: CompanyId) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM knowledge_source WHERE company_id = $1 ORDER BY title', [companyId]);
    return r.rows.map((x) => j(x.data) as KnowledgeSource);
  }
  async replaceChunks(companyId: CompanyId, sourceId: string, chunks: KnowledgeChunk[]) {
    await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM knowledge_chunk WHERE company_id = $1 AND source_id = $2', [companyId, sourceId]);
      for (const c of chunks)
        await tx.query('INSERT INTO knowledge_chunk (company_id, source_id, document_version_id, seq, locator, text) VALUES ($1,$2,$3,$4,$5,$6)', [companyId, sourceId, c.documentVersionId, c.seq, c.locator, c.text]);
    });
  }
  async searchChunks(companyId: CompanyId, query: string, opts: { categories?: string[]; limit: number; now: Date }) {
    const t = terms(query);
    if (!t.length) return [];
    const r = await this.db.query<Record<string, any>>(
      `SELECT c.*, s.data AS source, ts_rank(to_tsvector('simple', c.text), to_tsquery('simple', $2)) AS score
       FROM knowledge_chunk c JOIN knowledge_source s ON s.company_id = c.company_id AND s.id = c.source_id
       WHERE c.company_id = $1 AND s.status = 'approved' AND to_tsvector('simple', c.text) @@ to_tsquery('simple', $2)
       ORDER BY score DESC LIMIT $3`,
      [companyId, t.map((x) => x.replace(/'/g, '')).join(' | '), opts.limit * 3],
    );
    return r.rows
      .filter((x) => usable(j(x.source) as KnowledgeSource, opts.now, opts.categories))
      .slice(0, opts.limit)
      .map((x) => ({ companyId: x.company_id, sourceId: x.source_id, documentVersionId: x.document_version_id, seq: Number(x.seq), locator: x.locator, text: x.text, title: (j(x.source) as KnowledgeSource).title, score: Number(x.score) }));
  }
  async saveFact(f: KnowledgeFact) {
    await this.db.query(`INSERT INTO knowledge_fact (company_id, id, status, data) VALUES ($1,$2,$3,$4) ON CONFLICT (company_id, id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data`, [
      f.companyId,
      f.id,
      f.status,
      JSON.stringify(f),
    ]);
  }
  async facts(companyId: CompanyId) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM knowledge_fact WHERE company_id = $1', [companyId]);
    return r.rows.map((x) => j(x.data) as KnowledgeFact);
  }

  async saveRecord(r: CrmRecord) {
    await this.db.query(`INSERT INTO crm_record (company_id, id, kind, version, data) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (company_id, id) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data`, [
      r.companyId,
      r.id,
      r.kind,
      r.version,
      JSON.stringify(r),
    ]);
  }
  async record(companyId: CompanyId, id: string) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM crm_record WHERE company_id = $1 AND id = $2', [companyId, id]);
    return r.rows[0] ? (j(r.rows[0].data) as CrmRecord) : undefined;
  }
  async records(companyId: CompanyId, kind?: string) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM crm_record WHERE company_id = $1 AND ($2::text IS NULL OR kind = $2)', [companyId, kind ?? null]);
    return r.rows.map((x) => j(x.data) as CrmRecord);
  }
  async savePatch(p: CrmPatch) {
    await this.db.query(`INSERT INTO crm_patch (company_id, id, record_id, status, data) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (company_id, id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data`, [
      p.companyId,
      p.id,
      p.recordId ?? null,
      p.status,
      JSON.stringify(p),
    ]);
  }
  async patch(companyId: CompanyId, id: string) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM crm_patch WHERE company_id = $1 AND id = $2', [companyId, id]);
    return r.rows[0] ? (j(r.rows[0].data) as CrmPatch) : undefined;
  }
  async patches(companyId: CompanyId, status?: string) {
    const r = await this.db.query<{ data: unknown }>('SELECT data FROM crm_patch WHERE company_id = $1 AND ($2::text IS NULL OR status = $2)', [companyId, status ?? null]);
    return r.rows.map((x) => j(x.data) as CrmPatch);
  }
}
