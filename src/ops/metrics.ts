/**
 * Operational measurements (spec §18): latencies as rolling samples with
 * percentiles, plus counters. In-process and reset on restart; durable
 * facts (actions, costs, connector health) are computed from their stores.
 */
export class Metrics {
  private samples = new Map<string, number[]>();
  private counters = new Map<string, number>();

  observe(name: string, value: number): void {
    const s = this.samples.get(name) ?? [];
    s.push(value);
    if (s.length > 500) s.shift();
    this.samples.set(name, s);
  }

  async time<T>(name: string, fn: () => Promise<T>, now: () => number = Date.now): Promise<T> {
    const t0 = now();
    try {
      return await fn();
    } finally {
      this.observe(name, now() - t0);
    }
  }

  count(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  snapshot() {
    const pct = (xs: number[], p: number) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : null;
    };
    return {
      latenciesMs: Object.fromEntries([...this.samples].map(([k, xs]) => [k, { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95) }])),
      counters: Object.fromEntries(this.counters),
    };
  }
}
