import { z } from 'zod';
import type { ModelProvider } from '../core/model.js';
import { newId } from '../core/util.js';
import { renderUntrusted, wrapUntrusted } from '../security/untrusted.js';
import type { CostLedger } from '../ops/costs.js';
import type { CompanyId, RoleOutput, RoleVersion } from './model.js';

/**
 * Role executor (blueprint §8, §9, P01): loads an immutable role version,
 * receives only the evidence the workflow retrieved for this company,
 * calls the model with a strict output schema, validates the result and
 * accounts the cost against the run budget. Refusals, malformed or
 * incomplete output and timeouts become explicit failed/blocked results,
 * never silent success.
 */
export interface Evidence {
  sourceId: string;
  title?: string;
  locator?: string;
  text: string;
  /** Internal records (CRM, tasks) are trusted data; anything external is labeled untrusted. */
  trusted?: boolean;
}

export interface ExecuteInput<T> {
  role: RoleVersion;
  companyId: CompanyId;
  companyContext: string;
  task: string;
  evidence: Evidence[];
  dataSchema: { schema: Record<string, unknown>; parse: (x: unknown) => T };
  budget: { remainingEur: number };
}

const ENVELOPE = (data: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'data', 'sources', 'assumptions', 'proposed_actions', 'blockers'],
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked', 'needs_review'] },
    summary: { type: 'string' },
    data,
    sources: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['sourceId', 'locator', 'note'], properties: { sourceId: { type: 'string' }, locator: { type: 'string' }, note: { type: 'string' } } } },
    assumptions: { type: 'array', items: { type: 'string' } },
    proposed_actions: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['tool', 'target', 'reason'], properties: { tool: { type: 'string' }, target: { type: 'string' }, reason: { type: 'string' } } },
    },
    blockers: { type: 'array', items: { type: 'string' } },
  },
});

const Envelope = z.object({
  status: z.enum(['completed', 'blocked', 'needs_review']),
  summary: z.string(),
  data: z.unknown(),
  sources: z.array(z.object({ sourceId: z.string(), locator: z.string().optional(), note: z.string().optional() })),
  assumptions: z.array(z.string()),
  proposed_actions: z.array(z.object({ tool: z.string(), target: z.string(), reason: z.string() })),
  blockers: z.array(z.string()),
});

export class RoleExecutor {
  constructor(
    private d: { model?: ModelProvider; modelName: string; promptVersion: string; costs: CostLedger; now?: () => number },
  ) {}

  get available(): boolean {
    return !!this.d.model;
  }

  async execute<T>(i: ExecuteInput<T>): Promise<RoleOutput<T> & { costEur: number }> {
    const fail = (summary: string, blocker: string): RoleOutput<T> & { costEur: number } => ({ status: 'failed', summary, artifacts: [], sources: [], assumptions: [], proposed_actions: [], blockers: [blocker], costEur: 0 });
    if (!this.d.model) return { ...fail('No AI model is configured', 'Set OPENAI_API_KEY or ANTHROPIC_API_KEY'), status: 'blocked' };
    if (i.budget.remainingEur < i.role.budgetEur * 0.2) return { ...fail('Run budget exhausted', 'Budget exhausted before this step'), status: 'blocked' };
    const nonce = newId('n').slice(2, 10);
    const evidence = i.evidence.length
      ? i.evidence
          .map((e) =>
            e.trusted
              ? `[source ${e.sourceId}${e.locator ? ` @ ${e.locator}` : ''}] ${e.title ?? ''}\n${e.text}`
              : renderUntrusted(wrapUntrusted(`source:${e.sourceId}${e.locator ? `@${e.locator}` : ''} ${e.title ?? ''}`, e.text), nonce),
          )
          .join('\n\n')
      : '(no evidence was provided for this step)';
    const allowed = new Set(i.evidence.map((e) => e.sourceId));
    const system = [
      `You are role ${i.role.agentId} "${i.role.name}" (version ${i.role.version}) in ${i.companyContext}.`,
      i.role.promptTemplate,
      'Never request credentials, change permissions or claim an external action happened. Proposed actions are only proposals.',
      'Cite only sourceIds that appear in the evidence.',
    ].join('\n');
    let res;
    try {
      res = await Promise.race([
        this.d.model.complete({ system, input: `TASK:\n${i.task}\n\nEVIDENCE:\n${evidence}`, model: this.d.modelName, promptVersion: `${this.d.promptVersion}+${i.role.agentId}.v${i.role.version}`, jsonSchema: { name: `role_${i.role.agentId}`, schema: ENVELOPE(i.dataSchema.schema) }, maxOutputTokens: 4000 }),
        new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error('role timed out'), { timeout: true })), i.role.limits.timeoutMs).unref?.()),
      ]);
    } catch (e) {
      const err = e as { refusal?: boolean; timeout?: boolean; message: string };
      return fail(err.refusal ? 'The model declined this step' : err.timeout ? 'The step timed out' : 'The model call failed', err.message);
    }
    const costEur = res.usage ? this.d.costs.textCost(res.model || this.d.modelName, res.usage.inputTokens, res.usage.outputTokens) : 0;
    await this.d.costs.record('text', `company:${i.companyId}:${i.role.agentId}`, costEur);
    let env;
    try {
      env = Envelope.parse(JSON.parse(res.text));
    } catch {
      return { ...fail('The model returned malformed output', 'Output did not match the role schema'), costEur };
    }
    let data: T;
    try {
      data = i.dataSchema.parse(env.data);
    } catch (e) {
      return { ...fail('The role output failed validation', (e as Error).message.slice(0, 300)), costEur };
    }
    // A citation to a source that was never supplied is an invented source.
    const invented = env.sources.filter((s) => !allowed.has(s.sourceId));
    const blockers = [...env.blockers];
    if (invented.length) blockers.push(`cited unknown sources: ${invented.map((s) => s.sourceId).join(', ')}`);
    return {
      status: invented.length && env.status === 'completed' ? 'needs_review' : env.status,
      summary: env.summary,
      data,
      artifacts: [],
      sources: env.sources.filter((s) => allowed.has(s.sourceId)),
      assumptions: env.assumptions,
      proposed_actions: env.proposed_actions,
      blockers,
      costEur,
    };
  }
}
