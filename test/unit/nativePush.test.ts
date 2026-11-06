import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJennifer } from '../../src/app.js';
import { FakeClock } from '../../src/core/util.js';
const token = 'ExpoPushToken[test-device]';
const notice = { kind: 'decision' as const, title: 'Jennifer', body: 'Decision waiting', detail: 'Private contents', url: '/', urgent: true, dedupKey: 'test' };
async function setup() {
  const clock = new FakeClock('2026-11-02T12:00:00Z');
  const j = createJennifer({ clock });
  j.notifications.setNativeDeviceValidator(async () => true);
  await j.notifications.subscribeNative(token, 'device', new Date('2026-11-03T12:00:00Z'));
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'ok', id: 'ticket' } }) });
  vi.stubGlobal('fetch', fetch);
  return { j, clock, fetch };
}
afterEach(() => vi.unstubAllGlobals());
describe('native notifications', () => {
  it('registers once, replaces rotated tokens and expires sessions', async () => {
    const { j, clock } = await setup();
    await j.notifications.subscribeNative('ExpoPushToken[new]', 'device', new Date('2026-11-03T12:00:00Z'));
    expect(await j.notifications.nativeSubscriptions()).toHaveLength(1);
    clock.set('2026-11-04T12:00:00Z');
    expect(await j.notifications.nativeSubscriptions()).toEqual([]);
  });
  it('sends private payloads and tracks tickets without claiming delivery', async () => {
    const { j, fetch } = await setup();
    expect(await j.notifications.notify(notice)).toBe('sent');
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({ to: token, body: 'Decision waiting', channelId: 'jennifer' });
    expect(fetch.mock.calls[0]![1].body).not.toContain('Private contents');
    expect(await j.settings.get('native_push_receipts')).toEqual([{ id: 'ticket', token, at: Date.parse('2026-11-02T12:00:00Z') }]);
  });
  it('honors disabled prefs and rejects revoked devices before sending', async () => {
    const { j, fetch } = await setup();
    await j.notifications.setPrefs({ enabled: false });
    expect(await j.notifications.notify(notice)).toBe('disabled');
    await j.notifications.setPrefs({ enabled: true });
    j.notifications.setNativeDeviceValidator(async () => false);
    expect(await j.notifications.notify(notice)).toBe('no_devices');
    expect(fetch).not.toHaveBeenCalled();
    expect(await j.notifications.nativeSubscriptions()).toEqual([]);
  });
  it('removes invalid tokens and keeps transient failures retryable', async () => {
    const { j, fetch } = await setup();
    fetch.mockResolvedValueOnce({ ok: false });
    expect(await j.notifications.notify(notice)).toBe('no_devices');
    expect(await j.notifications.nativeSubscriptions()).toHaveLength(1);
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { status: 'error', details: { error: 'DeviceNotRegistered' } } }) });
    await j.notifications.notify(notice);
    expect(await j.notifications.nativeSubscriptions()).toEqual([]);
  });
  it('checks delayed receipts and preserves a rotated token', async () => {
    const { j, fetch, clock } = await setup();
    await j.notifications.notify(notice);
    await j.notifications.subscribeNative('ExpoPushToken[new]', 'device', new Date('2026-11-03T12:00:00Z'));
    clock.set('2026-11-02T12:16:00Z');
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { ticket: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }) });
    await j.notifications.checkNativeReceipts();
    expect((await j.notifications.nativeSubscriptions())[0]?.token).toBe('ExpoPushToken[new]');
    expect(await j.settings.get('native_push_receipts')).toEqual([]);
  });
});
