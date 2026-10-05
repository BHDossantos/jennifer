import { JenniferError } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import type { AuditLog } from '../audit/audit.js';
import type { CompanyRepo } from './repo.js';
import type { CompanyId, CrmKind, CrmPatch, CrmRecord } from './model.js';

/**
 * Lightweight company CRM (blueprint D09, §12): records change only through
 * versioned patches with source evidence. A patch carries the version it
 * was based on; if the record moved since, applying it is a reviewable
 * conflict, never a silent overwrite. Chat summaries cannot write here.
 */
export function canonicalDomain(input?: string): string | undefined {
  if (!input) return undefined;
  const s = input.trim().toLowerCase();
  const host = s.includes('@') ? s.split('@')[1] : s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0];
  return host?.replace(/^www\./, '').replace(/\.$/, '') || undefined;
}

export function canonicalName(name?: string): string {
  return (name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(s\.?r\.?l\.?|s\.?p\.?a\.?|ltd|llc|inc|gmbh|ltda|s\.?a\.?|co)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export class CompanyCrm {
  constructor(private d: { repo: CompanyRepo; clock: Clock; audit: AuditLog }) {}

  records(companyId: CompanyId, kind?: CrmKind) {
    return this.d.repo.records(companyId, kind);
  }

  /** Deterministic duplicate check (S05): same canonical domain, or same canonical name with no conflicting domain. */
  async findDuplicate(companyId: CompanyId, kind: CrmKind, fields: { name?: string; domain?: string; email?: string }): Promise<{ record?: CrmRecord; uncertain?: CrmRecord }> {
    const all = await this.d.repo.records(companyId, kind);
    const dom = canonicalDomain(fields.domain ?? fields.email);
    const email = fields.email?.trim().toLowerCase();
    const name = canonicalName(fields.name);
    for (const r of all) {
      const rd = canonicalDomain((r.fields.domain as string) ?? (r.fields.email as string));
      if (email && (r.fields.email as string | undefined)?.toLowerCase() === email) return { record: r };
      if (kind === 'account' && dom && rd === dom) return { record: r };
    }
    const byName = all.find((r) => name && canonicalName(r.fields.name as string) === name);
    if (byName) {
      const rd = canonicalDomain(byName.fields.domain as string);
      return !dom || !rd || rd === dom ? { uncertain: byName } : {};
    }
    return {};
  }

  async propose(companyId: CompanyId, p: Omit<CrmPatch, 'id' | 'companyId' | 'status' | 'createdAt'>): Promise<CrmPatch> {
    const patch: CrmPatch = { ...p, id: newId('patch'), companyId, status: 'proposed', createdAt: this.d.clock.now().toISOString() };
    await this.d.repo.savePatch(patch);
    return patch;
  }

  async decide(companyId: CompanyId, patchId: string, decision: 'apply' | 'reject', actor: string): Promise<{ patch: CrmPatch; record?: CrmRecord }> {
    const patch = await this.d.repo.patch(companyId, patchId);
    if (!patch) throw new JenniferError('crm.not_found', 'No such change');
    if (patch.status !== 'proposed') throw new JenniferError('crm.decided', `This change was already ${patch.status}`);
    if (decision === 'reject') {
      patch.status = 'rejected';
      await this.d.repo.savePatch(patch);
      this.d.audit.record(actor, 'crm.patch_rejected', patch.id, { companyId });
      return { patch };
    }
    const now = this.d.clock.now().toISOString();
    let record: CrmRecord;
    if (patch.recordId) {
      const cur = await this.d.repo.record(companyId, patch.recordId);
      if (!cur) throw new JenniferError('crm.not_found', 'The record no longer exists');
      if (patch.baseVersion !== undefined && cur.version !== patch.baseVersion) {
        patch.status = 'conflict';
        await this.d.repo.savePatch(patch);
        throw new JenniferError('crm.conflict', `The record changed since this was proposed (version ${patch.baseVersion} → ${cur.version}); review it again`);
      }
      record = { ...cur, version: cur.version + 1, updatedAt: now };
    } else {
      record = { id: newId(patch.kind.slice(0, 3)), companyId, kind: patch.kind, version: 1, fields: {}, provenance: {}, updatedAt: now };
    }
    for (const [k, c] of Object.entries(patch.changes)) {
      record.fields[k] = c.to;
      record.provenance[k] = { sourceId: c.source, runId: patch.runId, note: patch.reason };
    }
    await this.d.repo.saveRecord(record);
    patch.status = 'applied';
    patch.recordId = record.id;
    await this.d.repo.savePatch(patch);
    this.d.audit.record(actor, 'crm.patch_applied', patch.id, { companyId, recordId: record.id, version: record.version });
    return { patch, record };
  }
}
