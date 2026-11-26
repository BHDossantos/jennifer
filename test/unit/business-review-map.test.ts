import { describe, expect, it } from 'vitest';
import { previewBusinessReview, reviewRoutes } from '../../src/pilot/business-review-map.js';

describe('fixture-only business routing', () => {
  it('routes exactly seven verticals to distinct agents and never authorizes an action', () => {
    expect(Object.keys(reviewRoutes)).toEqual(['technology', 'insurance', 'dating', 'music', 'foundation', 'education', 'hospitality']);
    expect(new Set(Object.values(reviewRoutes).map(route => route.agent)).size).toBe(7);
    for (const [routeId, route] of Object.entries(reviewRoutes)) {
      expect(previewBusinessReview(`${routeId}:fixture:synthetic-1`)).toEqual({
        state: 'needs-human-review', routeId, fixtureId: 'fixture:synthetic-1', route, externalAction: false,
      });
      for (const value of Object.values(route)) expect(value.length).toBeGreaterThan(0);
    }
  });

  it('fails closed on unknown and malformed input', () => {
    for (const value of ['unknown:fixture:synthetic', 'constructor:fixture:synthetic'])
      expect(previewBusinessReview(value)).toEqual({ state: 'blocked', reason: 'unknown-route' });
    for (const value of [null, { id: 'technology:fixture:synthetic', send: true }, 'technology:real:1', 'technology:fixture:abc\n', 'insurance:fixture:person@example.test', 'dating:fixture:' + 'a'.repeat(65)])
      expect(previewBusinessReview(value)).toEqual({ state: 'blocked', reason: 'invalid-fixture' });
  });
});
