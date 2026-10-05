import { createHmac, timingSafeEqual } from 'node:crypto';
import { JenniferError } from '../core/types.js';
import { redactSecrets } from '../security/redaction.js';
import type { SuppressionList } from '../policy/controls.js';

/**
 * Bruno AI Workforce (BHDossantos/Bruno-AI-Workforce) as a read-only
 * business connector (docs/WORKFORCE_ASSESSMENT.md). Jennifer signs in as a
 * `viewer` user and only ever calls GET endpoints: the daily brief, CRM,
 * approvals waiting in Workforce, decisions and the do-not-contact list.
 * She never sends through Workforce. Workforce's signed `lead.replied`
 * webhook tells her when someone answers.
 */
export interface WorkforceConfig {
  url?: string;
  email?: string;
  password?: string;
  webhookSecret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Map Workforce business keys to Jennifer companies/spaces. */
export const WORKFORCE_BUSINESS_TO_SPACE: Record<string, string> = {
  personal: 'personal',
  insurance: 'insurance',
  bnb: 'technology',
  savorymind: 'restaurant',
  learnnoelia: 'learnnoelia',
  foundation: 'foundation',
};

export class WorkforceClient {
  private token?: { value: string; role: string; expiresAt: number };
  private signingIn?: Promise<string>;
  lastError?: string;
  lastSync?: Date;

  constructor(private c: WorkforceConfig) {}

  get configured(): boolean {
    return !!(this.c.url && this.c.email && this.c.password);
  }

  /** Role of the signed-in account ('viewer' expected); undefined before sign-in. */
  get role(): string | undefined {
    return this.token?.role;
  }

  private now() {
    return (this.c.now ?? Date.now)();
  }

  private base() {
    if (!this.c.url) throw new JenniferError('workforce.not_configured', 'Set WORKFORCE_URL, WORKFORCE_EMAIL and WORKFORCE_PASSWORD in Render');
    return this.c.url.replace(/\/$/, '');
  }

  private async signIn(): Promise<string> {
    if (!this.configured) throw new JenniferError('workforce.not_configured', 'Set WORKFORCE_URL, WORKFORCE_EMAIL and WORKFORCE_PASSWORD in Render');
    const res = await (this.c.fetchImpl ?? fetch)(`${this.base()}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ username: this.c.email!, password: this.c.password! }).toString(),
    });
    if (res.status === 401 || res.status === 403) throw this.fail('workforce.auth', 'Workforce rejected the sign-in (check WORKFORCE_EMAIL / WORKFORCE_PASSWORD, and that the user is active)');
    if (!res.ok) throw this.fail('workforce.unavailable', `Workforce sign-in failed (${res.status})`);
    const { access_token } = (await res.json()) as { access_token?: string };
    if (!access_token) throw this.fail('workforce.unavailable', 'Workforce returned no token');
    let role = 'unknown';
    try {
      role = String(JSON.parse(Buffer.from(access_token.split('.')[1] ?? '', 'base64url').toString()).role ?? 'unknown');
    } catch {
      /* role is informational only */
    }
    // Tokens last 24 h; refresh an hour early.
    this.token = { value: access_token, role, expiresAt: this.now() + 23 * 3600_000 };
    return access_token;
  }

  private fail(code: string, message: string) {
    this.lastError = message;
    return new JenniferError(code, message);
  }

  /** GET only: Jennifer never writes to Workforce. */
  async get<T = unknown>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();
    const url = `${this.base()}${path}${qs ? `?${qs}` : ''}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = this.token && this.token.expiresAt > this.now() ? this.token.value : await (this.signingIn ??= this.signIn().finally(() => (this.signingIn = undefined)));
      const res = await (this.c.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      if (res.status === 401 && attempt === 0) {
        this.token = undefined;
        continue;
      }
      if (res.status === 403) throw this.fail('workforce.forbidden', `Workforce does not let this account read ${path}`);
      if (!res.ok) throw this.fail('workforce.unavailable', `Workforce ${path} failed (${res.status}): ${redactSecrets(await res.text()).slice(0, 160)}`);
      this.lastError = undefined;
      this.lastSync = new Date(this.now());
      return (await res.json()) as T;
    }
    throw this.fail('workforce.auth', 'Workforce sign-in expired and could not be renewed');
  }

  async overview() {
    const [brief, summary, approvals] = await Promise.all([
      this.get<Record<string, unknown>>('/brief/today', { top: 5 }),
      this.get<Record<string, unknown>>('/dashboard/summary').catch(() => undefined),
      this.get<{ count?: number; items?: unknown[]; auto_sending?: unknown }>('/approvals', { limit: 10 }).catch(() => undefined),
    ]);
    return {
      brief,
      summary,
      approvalsWaitingInWorkforce: approvals?.count ?? approvals?.items?.length ?? 0,
      topApprovals: (approvals?.items ?? []).slice(0, 10),
      autoSendingInWorkforce: approvals?.auto_sending,
    };
  }

  searchCrm(q: string, limit = 25) {
    return this.get<unknown[]>('/crm', { q, limit });
  }

  approvals(limit = 50) {
    return this.get<{ count: number; items: unknown[]; auto_sending?: unknown }>('/approvals', { limit });
  }

  decisions() {
    return this.get<unknown[]>('/decisions');
  }

  businesses() {
    return this.get<{ businesses: Array<{ key: string; label: string; active?: boolean }>; count: number }>('/businesses', { active_only: 'false' });
  }

  /** Copy Workforce's do-not-contact list into Jennifer's suppressions, so "stop" holds in both systems. */
  async syncDoNotContact(suppressions: SuppressionList): Promise<{ added: number; total: number }> {
    const r = await this.get<{ entries?: Array<{ kind?: string; value?: string; reason?: string }> }>('/compliance/dnc');
    const entries = r.entries ?? [];
    const have = new Set(suppressions.active().map((s) => s.address).filter(Boolean));
    let added = 0;
    for (const e of entries) {
      const address = e.kind === 'phone' ? normalizePhone(e.value ?? '') : (e.value ?? '').trim().toLowerCase();
      if (!address || have.has(address)) continue;
      if (e.kind === 'email' && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(address)) continue;
      suppressions.add({ address, channels: 'all', reason: `Workforce do-not-contact${e.reason ? `: ${String(e.reason).slice(0, 120)}` : ''}`, createdBy: 'workforce' });
      have.add(address);
      added++;
    }
    return { added, total: entries.length };
  }

  /** X-Bruno-Signature: lowercase hex HMAC-SHA256 of the exact body. */
  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!this.c.webhookSecret || !signature) return false;
    const want = Buffer.from(createHmac('sha256', this.c.webhookSecret).update(rawBody).digest('hex'));
    const got = Buffer.from(signature.trim().toLowerCase().replace(/^sha256=/, ''));
    return want.length === got.length && timingSafeEqual(want, got);
  }
}

/** US numbers in Workforce are often stored without +1. */
export function normalizePhone(v: string): string {
  const raw = v.trim();
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return '';
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}
