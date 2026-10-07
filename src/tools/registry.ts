import { z } from 'zod';
import { JenniferError } from '../core/types.js';

/**
 * Every tool has a JSON schema, allowed scopes, validation, timeout, rate
 * limit, retry policy and side-effect classification (spec §15). There is no
 * generic "run anything" tool. Tools with external side effects never act
 * directly: they return a proposed ActionIntent for the executor.
 */
export type SideEffect = 'none' | 'read' | 'draft' | 'external_write';

export interface ToolContext {
  ownerId: string;
  role: string; // specialist role or 'jennifer'
  allowedTools: ReadonlySet<string>;
  scopes: ReadonlySet<string>;
  /** Bruno's own latest words in this conversation (typed text, or his speech transcribed by the provider), never model output. */
  ownerWords?: string;
  /** When Bruno's latest words arrived; anything proposed after this cannot be what he is answering. */
  ownerWordsAt?: Date;
}

export interface ToolDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  name: string;
  description: string;
  input: I;
  requiredScopes: string[];
  sideEffect: SideEffect;
  timeoutMs: number;
  rateLimitPerMinute: number;
  retry: { maxAttempts: number; retryOn: 'transient' | 'never' };
  validate?: (input: z.infer<I>, ctx: ToolContext) => string | undefined;
  run: (input: z.infer<I>, ctx: ToolContext) => Promise<O>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private calls = new Map<string, number[]>();

  constructor(private now: () => number = Date.now) {}

  register<I extends z.ZodTypeAny, O>(t: ToolDefinition<I, O>): void {
    if (/^(run|exec|shell|eval|http_request|browse_any)/.test(t.name)) throw new JenniferError('tool.forbidden', `Generic tool ${t.name} is not allowed`);
    this.tools.set(t.name, t as unknown as ToolDefinition);
  }

  list(): Array<{ name: string; description: string; sideEffect: SideEffect; schema: unknown }> {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, sideEffect: t.sideEffect, schema: z.toJSONSchema(t.input) }));
  }

  /** Tool specs filtered to what a role may see (narrow tool sets per specialist). */
  forRole(ctx: ToolContext) {
    return this.list().filter((t) => ctx.allowedTools.has(t.name));
  }

  async invoke(name: string, rawInput: unknown, ctx: ToolContext): Promise<unknown> {
    const t = this.tools.get(name);
    if (!t) throw new JenniferError('tool.unknown', `Unknown tool ${name}`);
    if (!ctx.allowedTools.has(name)) throw new JenniferError('tool.not_permitted', `${ctx.role} may not use ${name}`);
    const missing = t.requiredScopes.filter((s) => !ctx.scopes.has(s));
    if (missing.length) throw new JenniferError('tool.missing_scope', `${name} requires ${missing.join(', ')}`);
    const input = t.input.parse(rawInput);
    const err = t.validate?.(input, ctx);
    if (err) throw new JenniferError('tool.invalid', err);
    this.rateLimit(t);

    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        return await withTimeout(t.run(input, ctx), t.timeoutMs, name);
      } catch (e) {
        const transient = e instanceof ToolTimeout || (e as { transient?: boolean }).transient === true;
        if (t.retry.retryOn === 'transient' && transient && attempt < t.retry.maxAttempts && t.sideEffect !== 'external_write') continue;
        throw e;
      }
    }
  }

  private rateLimit(t: ToolDefinition): void {
    const now = this.now();
    const recent = (this.calls.get(t.name) ?? []).filter((ts) => now - ts < 60_000);
    if (recent.length >= t.rateLimitPerMinute) throw new JenniferError('tool.rate_limited', `${t.name} rate limit reached`);
    recent.push(now);
    this.calls.set(t.name, recent);
  }
}

export class ToolTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeout(`${name} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
