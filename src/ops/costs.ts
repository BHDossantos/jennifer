import { JenniferError } from '../core/types.js';
import type { Clock } from '../core/util.js';
import type { SettingsStore } from '../core/settings.js';
import type { ModelProvider, ModelRequest, ModelResponse } from '../core/model.js';
import type { AgentStep, ToolCallingModel, ToolSpec, AgentItem } from '../core/agentLoop.js';

/**
 * Operating cost ledger and monthly ceiling (spec §18). Costs are
 * estimates from token counts and configured prices, kept per month and
 * category; they are not a provider invoice. When the month reaches the
 * ceiling, optional model work (chat, missions, drafts, voice) stops with a
 * clear message instead of silently running up a bill.
 */
export type CostCategory = 'text' | 'voice' | 'phone' | 'other';

export interface Pricing {
  /** EUR per million tokens, by model-name prefix; `default` applies otherwise. */
  text: Record<string, { inputPerM: number; outputPerM: number }>;
  voicePerMinute: number;
  phonePerMinute: number;
}

/** Rough planning prices (EUR); override with JENNIFER_PRICING_JSON after checking current vendor rates. */
export const DEFAULT_PRICING: Pricing = {
  text: {
    'claude-opus': { inputPerM: 4.6, outputPerM: 23 },
    'claude-sonnet': { inputPerM: 2.8, outputPerM: 14 },
    'gpt-5-mini': { inputPerM: 0.25, outputPerM: 1.9 },
    'gpt-5': { inputPerM: 1.15, outputPerM: 9.2 },
    default: { inputPerM: 2.5, outputPerM: 12 },
  },
  voicePerMinute: 0.2,
  phonePerMinute: 0.25,
};

export interface MonthTotals {
  month: string; // YYYY-MM
  totalEur: number;
  byCategory: Record<CostCategory, number>;
  /** Per-purpose totals (chat, mission, draft, brief...) with counts, for cost per task. */
  byPurpose: Record<string, { eur: number; count: number }>;
}

export class CostLedger {
  private current?: MonthTotals;
  private listeners: Array<(t: MonthTotals) => void> = [];

  constructor(
    private d: { clock: Clock; settings: SettingsStore; ceilingEur: number; pricing?: Pricing },
  ) {}

  get pricing(): Pricing {
    return this.d.pricing ?? DEFAULT_PRICING;
  }

  get ceilingEur(): number {
    return this.d.ceilingEur;
  }

  onChange(fn: (t: MonthTotals) => void): void {
    this.listeners.push(fn);
  }

  private month(): string {
    return this.d.clock.now().toISOString().slice(0, 7);
  }

  private loading?: { month: string; p: Promise<void> };

  private async load(): Promise<MonthTotals> {
    const m = this.month();
    if (this.current?.month === m) return this.current;
    if (this.loading?.month !== m)
      this.loading = {
        month: m,
        p: this.d.settings.get<MonthTotals>(`costs.${m}`).then((t) => {
          this.current = t ?? { month: m, totalEur: 0, byCategory: { text: 0, voice: 0, phone: 0, other: 0 }, byPurpose: {} };
        }),
      };
    await this.loading.p;
    return this.current!;
  }

  async totals(): Promise<MonthTotals & { ceilingEur: number; remainingEur: number }> {
    const t = await this.load();
    return { ...structuredClone(t), ceilingEur: this.d.ceilingEur, remainingEur: Math.max(0, this.d.ceilingEur - t.totalEur) };
  }

  textCost(model: string, inputTokens: number, outputTokens: number): number {
    const table = this.pricing.text;
    const key = Object.keys(table)
      .filter((k) => k !== 'default' && model.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const p = table[key ?? 'default'] ?? DEFAULT_PRICING.text.default!;
    return (inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1e6;
  }

  async record(category: CostCategory, purpose: string, eur: number): Promise<void> {
    if (!(eur > 0)) return;
    const t = await this.load();
    t.totalEur += eur;
    t.byCategory[category] += eur;
    const p = (t.byPurpose[purpose] ??= { eur: 0, count: 0 });
    p.eur += eur;
    p.count += 1;
    await this.d.settings.set(`costs.${t.month}`, t);
    this.listeners.forEach((l) => l(t));
  }

  /** Throws when this month's estimated spend has reached the ceiling. */
  async assertBudget(purpose: string): Promise<void> {
    const t = await this.load();
    if (t.totalEur >= this.d.ceilingEur)
      throw new JenniferError('budget.ceiling_reached', `This month's operating ceiling (€${this.d.ceilingEur}) is reached, so I paused ${purpose}. Raise JENNIFER_MONTHLY_CEILING_EUR or wait for next month.`);
  }
}

/** Single-shot model calls, metered and stopped at the ceiling. */
export class MeteredModel implements ModelProvider {
  constructor(
    private inner: ModelProvider,
    private ledger: CostLedger,
    private purpose = 'draft',
  ) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    await this.ledger.assertBudget(this.purpose);
    const r = await this.inner.complete(req);
    if (r.usage) await this.ledger.record('text', this.purpose, this.ledger.textCost(r.model || req.model, r.usage.inputTokens, r.usage.outputTokens));
    return r;
  }
}

/** Tool-loop steps (chat, missions), metered per step. */
export class MeteredToolModel implements ToolCallingModel {
  constructor(
    private inner: ToolCallingModel,
    private ledger: CostLedger,
    private purpose: string,
  ) {}
  async step(req: { system: string; history: AgentItem[]; tools: ToolSpec[]; model: string }): Promise<AgentStep> {
    await this.ledger.assertBudget(this.purpose);
    const r = await this.inner.step(req);
    if (r.usage) await this.ledger.record('text', this.purpose, this.ledger.textCost(req.model, r.usage.inputTokens, r.usage.outputTokens));
    return r;
  }
}
