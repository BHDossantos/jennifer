import { createHash } from 'node:crypto';
import { JenniferError } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import type { AuditLog } from '../audit/audit.js';
import { safeFetchText } from '../security/untrusted.js';
import { htmlToText } from '../research/web.js';
import type { CompanyRepo } from './repo.js';
import type { CompanyId, KnowledgeChunk, KnowledgeFact, KnowledgeSource } from './model.js';

/**
 * Company brain (blueprint §7): approved company knowledge, per company.
 * Ingestion: authorize → fetch/parse → normalize → split on paragraph
 * boundaries → attach company/category → index → owner review → publish.
 * New sources are not trusted knowledge until approved; revoking a source
 * removes it from every later retrieval.
 */
export class CompanyBrain {
  constructor(
    private d: { repo: CompanyRepo; clock: Clock; audit: AuditLog; fetchImpl?: typeof fetch; resolve?: (host: string) => Promise<string[]> },
  ) {}

  static chunk(text: string, maxChars = 1200): Array<{ locator: string; text: string }> {
    const paras = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const out: Array<{ locator: string; text: string }> = [];
    let buf: string[] = [];
    let start = 1;
    paras.forEach((p, i) => {
      if (buf.join('\n\n').length + p.length > maxChars && buf.length) {
        out.push({ locator: `¶${start}-${i}`, text: buf.join('\n\n') });
        buf = [];
        start = i + 1;
      }
      buf.push(p.length > maxChars * 2 ? p.slice(0, maxChars * 2) : p);
    });
    if (buf.length) out.push({ locator: `¶${start}-${paras.length}`, text: buf.join('\n\n') });
    return out;
  }

  async addSource(
    companyId: CompanyId,
    input: { title: string; category: string; classification?: KnowledgeSource['classification']; text?: string; url?: string; effectiveAt?: string; expiresAt?: string; reviewDueAt?: string },
    actor: string,
  ): Promise<KnowledgeSource> {
    const now = this.d.clock.now().toISOString();
    const src: KnowledgeSource = {
      id: newId('src'),
      companyId,
      title: input.title,
      classification: input.classification ?? 'internal',
      category: input.category,
      status: 'ingesting',
      documentVersionId: newId('docv'),
      contentHash: '',
      ownerId: actor,
      origin: input.url ? { kind: 'url', ref: input.url } : { kind: 'text' },
      retrievedAt: now,
      effectiveAt: input.effectiveAt,
      expiresAt: input.expiresAt,
      reviewDueAt: input.reviewDueAt,
    };
    await this.d.repo.saveSource(src);
    try {
      let text = input.text ?? '';
      if (input.url) {
        const r = await safeFetchText(input.url, { maxBytes: 5 * 1024 * 1024, fetchImpl: this.d.fetchImpl, resolve: this.d.resolve });
        if (r.status >= 400) throw new Error(`source returned ${r.status}`);
        text = /<html|<body|<p[\s>]/i.test(r.text) ? htmlToText(r.text).text : r.text;
      }
      text = text.trim();
      if (!text) throw new Error('no text could be extracted');
      src.contentHash = createHash('sha256').update(text).digest('hex');
      const chunks: KnowledgeChunk[] = CompanyBrain.chunk(text).map((c, i) => ({ companyId, sourceId: src.id, documentVersionId: src.documentVersionId, seq: i, locator: c.locator, text: c.text }));
      await this.d.repo.replaceChunks(companyId, src.id, chunks);
      src.status = 'pending_review';
    } catch (e) {
      src.status = 'failed';
      src.error = (e as Error).message;
    }
    await this.d.repo.saveSource(src);
    this.d.audit.record(actor, 'knowledge.source_added', src.id, { companyId, status: src.status, category: src.category });
    return src;
  }

  async review(companyId: CompanyId, sourceId: string, decision: 'approved' | 'revoked', actor: string): Promise<KnowledgeSource> {
    const src = await this.d.repo.source(companyId, sourceId);
    if (!src) throw new JenniferError('knowledge.not_found', 'No such source');
    if (decision === 'approved' && src.status !== 'pending_review' && src.status !== 'approved') throw new JenniferError('knowledge.bad_state', `Source is ${src.status}`);
    src.status = decision;
    await this.d.repo.saveSource(src);
    this.d.audit.record(actor, `knowledge.source_${decision}`, src.id, { companyId });
    return src;
  }

  /** Only approved, unexpired sources of the allowed categories in this one company. */
  /** All approved material in these categories (for work that must respect the whole offer or brand, not just matching snippets). */
  approved(companyId: CompanyId, categories: string[], limit = 12) {
    return this.d.repo.approvedChunks(companyId, { categories, limit, now: this.d.clock.now() });
  }

  search(companyId: CompanyId, query: string, opts: { categories?: string[]; limit?: number } = {}) {
    return this.d.repo.searchChunks(companyId, query, { categories: opts.categories, limit: opts.limit ?? 6, now: this.d.clock.now() });
  }

  async approvedCategories(companyId: CompanyId): Promise<Set<string>> {
    const now = this.d.clock.now().getTime();
    return new Set((await this.d.repo.sources(companyId)).filter((s) => s.status === 'approved' && (!s.expiresAt || Date.parse(s.expiresAt) > now)).map((s) => s.category));
  }

  async proposeFact(companyId: CompanyId, f: Omit<KnowledgeFact, 'id' | 'companyId' | 'status'>): Promise<KnowledgeFact> {
    const fact: KnowledgeFact = { ...f, id: newId('fact'), companyId, status: 'proposed' };
    await this.d.repo.saveFact(fact);
    return fact;
  }

  async decideFact(companyId: CompanyId, id: string, status: 'approved' | 'rejected', actor: string) {
    const fact = (await this.d.repo.facts(companyId)).find((f) => f.id === id);
    if (!fact) throw new JenniferError('knowledge.not_found', 'No such fact');
    fact.status = status;
    await this.d.repo.saveFact(fact);
    this.d.audit.record(actor, `knowledge.fact_${status}`, id, { companyId });
    return fact;
  }
}
