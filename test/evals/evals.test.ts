import { writeFileSync, mkdirSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { catalog } from './catalog.js';

/**
 * Evaluation suite (spec §20). Run with `npm run eval` to also write
 * evals/report.json (per-family pass rates, critical failures).
 */
const scenarios = catalog();
const results: Array<{ id: string; family: string; lang: string; critical: boolean; passed: boolean; error?: string }> = [];

describe('evaluation catalog', () => {
  it('has at least 200 curated scenarios across all four languages', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(200);
    expect(new Set(scenarios.map((s) => s.lang))).toEqual(new Set(['en', 'it', 'pt-BR', 'es']));
  });

  for (const s of scenarios) {
    it(`${s.critical ? '[critical] ' : ''}${s.id}: ${s.description}`, async () => {
      try {
        await s.run();
        results.push({ id: s.id, family: s.family, lang: s.lang, critical: s.critical, passed: true });
      } catch (e) {
        results.push({ id: s.id, family: s.family, lang: s.lang, critical: s.critical, passed: false, error: (e as Error).message });
        throw e;
      }
    });
  }

  afterAll(() => {
    if (!process.env.EVAL_REPORT) return;
    const byFamily: Record<string, { passed: number; total: number }> = {};
    for (const r of results) {
      const f = (byFamily[r.family] ??= { passed: 0, total: 0 });
      f.total++;
      if (r.passed) f.passed++;
    }
    mkdirSync('evals', { recursive: true });
    writeFileSync(
      'evals/report.json',
      JSON.stringify({ generatedAt: new Date().toISOString(), total: results.length, passed: results.filter((r) => r.passed).length, criticalFailures: results.filter((r) => r.critical && !r.passed), byFamily, failures: results.filter((r) => !r.passed) }, null, 2) + '\n',
    );
  });
});
