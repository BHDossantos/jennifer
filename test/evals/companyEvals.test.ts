import { describe, expect, it } from 'vitest';
import { companyCatalog } from './companyCatalog.js';

const scenarios = companyCatalog();

describe('Company OS pilot evaluation set', () => {
  it('has at least 100 cases across five languages', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(100);
    expect(new Set(scenarios.map((s) => s.lang))).toEqual(new Set(['en', 'it', 'pt', 'es', 'fr']));
  });
  for (const s of scenarios) it(`${s.critical ? '[critical] ' : ''}${s.id}: ${s.description}`, () => s.run());
});
