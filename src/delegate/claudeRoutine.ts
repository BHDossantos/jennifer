import { createHmac, timingSafeEqual } from 'node:crypto';
import { JenniferError } from '../core/types.js';
import { redactSecrets } from '../security/redaction.js';
import type { ActionHandler, ActionIntent, PerformResult, ResolvedAction } from '../actions/model.js';

/**
 * Hands-on work through Bruno's own Claude account (Claude Code Routines).
 *
 * Jennifer decides what needs doing; after Bruno approves the exact task, she
 * fires his routine's official API trigger. The routine runs as Bruno in
 * Claude, using the connectors on his claude.ai account (Gmail, Google
 * Calendar, Drive...). Jennifer never sees those credentials. The routine
 * reports back to a per-task callback, signed with an HMAC only Jennifer can
 * produce, so a forged report cannot mark work done.
 */
export type DelegateCategory = 'calendar' | 'email' | 'files' | 'social' | 'other';

export interface DelegateTaskPayload {
  task: string;
  category: DelegateCategory;
}

export interface DelegateReport {
  actionId: string;
  status: 'done' | 'failed' | 'needs_input';
  summary: string;
  receivedAt: Date;
}

const ROUTINE_URL = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/;

export class ClaudeRoutineDelegate {
  private reports = new Map<string, DelegateReport>();

  constructor(
    private c: { routineUrl?: string; token?: string; callbackBase?: string; secret?: string; fetchImpl?: typeof fetch; now?: () => Date },
  ) {
    if (c.routineUrl && !ROUTINE_URL.test(c.routineUrl)) throw new Error('CLAUDE_ROUTINE_URL must be the routine fire URL from claude.ai/code/routines (https://api.anthropic.com/v1/claude_code/routines/trig_…/fire)');
  }

  get configured(): boolean {
    return !!(this.c.routineUrl && this.c.token && this.c.callbackBase && this.c.secret);
  }

  /** Per-task report token: HMAC(secret, actionId). Only valid for that one task. */
  reportToken(actionId: string): string {
    if (!this.c.secret) throw new JenniferError('delegate.not_configured', 'Delegation needs JENNIFER_WEBHOOK_SECRET');
    return createHmac('sha256', this.c.secret).update(`delegate:${actionId}`).digest('base64url');
  }

  verifyReportToken(actionId: string, token: string): boolean {
    const want = Buffer.from(this.reportToken(actionId));
    const got = Buffer.from(token);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  callbackUrl(): string {
    return `${(this.c.callbackBase ?? '').replace(/\/$/, '')}/v1/webhooks/claude-routine`;
  }

  /** The text Claude receives inside its routine-fire-payload block. */
  fireText(actionId: string, p: DelegateTaskPayload): string {
    return JSON.stringify(
      {
        from: 'Jennifer (Bruno’s assistant)',
        approvedByBruno: true,
        actionId,
        category: p.category,
        task: p.task,
        report: { url: this.callbackUrl(), method: 'POST', json: { actionId, token: this.reportToken(actionId), status: 'done | failed | needs_input', summary: 'what you did, in one or two sentences' } },
      },
      null,
      2,
    );
  }

  async fire(actionId: string, p: DelegateTaskPayload): Promise<{ sessionId?: string; sessionUrl?: string }> {
    if (!this.configured) throw new JenniferError('delegate.not_configured', 'Set CLAUDE_ROUTINE_URL and CLAUDE_ROUTINE_TOKEN in Render to let Claude do tasks for you');
    const res = await (this.c.fetchImpl ?? fetch)(this.c.routineUrl!, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.c.token}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: this.fireText(actionId, p) }),
    });
    if (res.status === 401 || res.status === 403) throw new JenniferError('delegate.auth', 'Claude rejected the routine token. Generate a new one in claude.ai/code/routines and update CLAUDE_ROUTINE_TOKEN');
    if (res.status === 429) throw new JenniferError('delegate.rate_limited', 'Claude routine limit reached (30 an hour). Try again later');
    if (!res.ok) throw new JenniferError('delegate.failed', `Claude routine failed (${res.status}): ${redactSecrets(await res.text()).slice(0, 200)}`);
    const j = (await res.json().catch(() => ({}))) as { claude_code_session_id?: string; claude_code_session_url?: string };
    return { sessionId: j.claude_code_session_id, sessionUrl: j.claude_code_session_url };
  }

  recordReport(r: Omit<DelegateReport, 'receivedAt'>): DelegateReport {
    const report = { ...r, summary: r.summary.slice(0, 2000), receivedAt: (this.c.now ?? (() => new Date()))() };
    this.reports.set(r.actionId, report);
    return report;
  }

  report(actionId: string): DelegateReport | undefined {
    return this.reports.get(actionId);
  }
}

export class DelegateTaskHandler implements ActionHandler<DelegateTaskPayload> {
  readonly type = 'delegate_task' as const;

  constructor(
    private delegate: ClaudeRoutineDelegate,
    private now: () => Date,
  ) {}

  resolve(intent: ActionIntent<DelegateTaskPayload>): ResolvedAction {
    const violations: string[] = [];
    if (!this.delegate.configured) violations.push('Claude is not connected yet (CLAUDE_ROUTINE_URL / CLAUDE_ROUTINE_TOKEN)');
    if (!intent.payload.task?.trim()) violations.push('the task is empty');
    if (typeof intent.payload.task !== 'string' || intent.payload.task.length > 2000) violations.push('the task must be text of at most 2000 characters');
    if (!['calendar', 'email', 'files', 'social', 'other'].includes(intent.payload.category)) violations.push('unknown task category');
    return {
      authority: {
        action: 'delegate_task',
        accountId: intent.accountId,
        space: intent.space,
        contactIds: [],
        recipientDomains: [],
        attachmentSpaces: [],
        recipientCount: 0,
        // Claude acts with full access to Bruno's connectors: every task needs his OK.
        isReply: false,
      },
      contactIds: [],
      addresses: [],
      violations,
      concerns: [],
    };
  }

  async perform(intent: ActionIntent<DelegateTaskPayload>): Promise<PerformResult> {
    try {
      const r = await this.delegate.fire(intent.id, intent.payload);
      return { kind: 'accepted', receipt: { providerMessageId: r.sessionId, deliveryStatus: 'accepted', evidence: r.sessionUrl ? `Claude is working on it: ${r.sessionUrl}` : 'Claude accepted the task' } };
    } catch (e) {
      const err = e as JenniferError;
      if (err.code === 'delegate.rate_limited') return { kind: 'rejected', error: err.message, retryable: true };
      if (err.code?.startsWith('delegate.')) return { kind: 'rejected', error: err.message, retryable: false };
      // Network failure: the routine may or may not have started. Never fire twice blindly.
      return { kind: 'ambiguous', error: err.message };
    }
  }

  async reconcile(intent: ActionIntent<DelegateTaskPayload>) {
    const r = this.delegate.report(intent.id);
    if (r) return { found: true as const, receipt: { deliveryStatus: 'accepted' as const, evidence: `Claude reported: ${r.status}` } };
    const age = this.now().getTime() - intent.createdAt.getTime();
    if (age < 30 * 60_000) return { found: 'pending' as const };
    throw new JenniferError('delegate.unconfirmed', 'Could not confirm whether Claude started this task. Check claude.ai/code/routines before retrying');
  }
}
