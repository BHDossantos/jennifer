import { describe, expect, it } from 'vitest';
import { actionRecovery } from '../../src/actions/recovery.js';
describe('read-only action recovery guidance', () => {
  it('never recommends repeating an uncertain action', () => {
    const result = actionRecovery({ state: 'unknown', attempts: 1, nextAttemptAt: new Date() });
    expect(result?.nextStep).toContain('Do not send a duplicate');
    expect(result?.nextAttemptAt).toBeNull();
  });
  it('shows retry time only for ready actions and keeps approval gates explicit', () => {
    const nextAttemptAt = new Date('2026-11-18T10:00:00Z');
    const result = actionRecovery({ state: 'ready', attempts: 2, nextAttemptAt });
    expect(result).toMatchObject({ title: 'Retry scheduled', attempts: 2, nextAttemptAt });
    expect(result?.nextStep).toContain('approval and safety checks');
    expect(actionRecovery({ state: 'failed', attempts: 2, nextAttemptAt })?.nextAttemptAt).toBeNull();
  });
  it('distinguishes acceptance from confirmed delivery', () => {
    expect(actionRecovery({ state: 'provider_accepted', attempts: 1 })?.nextStep).toContain('does not prove');
    expect(actionRecovery({ state: 'confirmed', attempts: 1 })).toBeNull();
  });
});
