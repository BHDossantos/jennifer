import webpush from 'web-push';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { KeyedMutex, type Clock } from '../core/util.js';
import type { SettingsStore } from '../core/settings.js';
import type { AuditLog } from '../audit/audit.js';

/**
 * Web Push for the installed iPhone app (spec §16): deduplicated, quiet
 * hours with urgent override, and lock-screen-safe text by default (no
 * message contents unless Bruno opts in).
 */
export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
export const NativePushTokenSchema = z.string().regex(/^(ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$/).max(256);
type NativeSub = { token: string; deviceId: string; expiresAt: string };
export type PushSub = z.infer<typeof PushSubscriptionSchema> & { label?: string; createdAt: string };

export const PrefsSchema = z.object({
  enabled: z.boolean().default(true),
  quietStart: z.string().regex(/^\d{2}:\d{2}$/).default('22:00'),
  quietEnd: z.string().regex(/^\d{2}:\d{2}$/).default('07:30'),
  timeZone: z.string().default('Europe/Rome'),
  showDetails: z.boolean().default(false), // lock-screen privacy
  kinds: z
    .object({ decision: z.boolean().default(true), mission: z.boolean().default(true), problem: z.boolean().default(true), call: z.boolean().default(true), message: z.boolean().default(false) })
    .default({ decision: true, mission: true, problem: true, call: true, message: false }),
});
export type NotificationPrefs = z.infer<typeof PrefsSchema>;

export interface Notice {
  kind: 'decision' | 'mission' | 'problem' | 'call' | 'message';
  title: string;
  /** Generic text shown when details are hidden. */
  body: string;
  /** Richer text, shown only when Bruno enables lock-screen details. */
  detail?: string;
  url: string;
  urgent?: boolean;
  dedupKey: string;
}

export type PushSender = (sub: PushSub, payload: string, opts: { TTL: number; urgency: 'normal' | 'high'; vapidDetails: { subject: string; publicKey: string; privateKey: string } }) => Promise<{ statusCode: number }>;

export interface SecretKV {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

const DEDUP_MS = 6 * 3600_000;

export class NotificationService {
  private sentKeys = new Map<string, number>();
  private held: Notice[] = [];
  private nativeMutex = new KeyedMutex();
  private nativeDeviceActive: (id: string) => Promise<boolean> = async () => false;

  setNativeDeviceValidator(validate: (id: string) => Promise<boolean>) {
    this.nativeDeviceActive = validate;
  }
  private vapid?: { publicKey: string; privateKey: string };

  constructor(
    private d: {
      clock: Clock;
      settings: SettingsStore;
      secrets: SecretKV;
      audit: AuditLog;
      subject: string; // mailto: or https: contact for push services
      send?: PushSender;
      /** Urgent notices when push is unavailable (e.g. SMS to Bruno's own phone). */
      fallback?: (n: Notice, text: string) => Promise<void>;
    },
  ) {}

  /** VAPID keys: env first, else generated once and kept in the secret store. */
  async keys(): Promise<{ publicKey: string; privateKey: string }> {
    if (this.vapid) return this.vapid;
    const pub = process.env.JENNIFER_VAPID_PUBLIC ?? (await this.d.secrets.get('vapid.public'));
    const priv = process.env.JENNIFER_VAPID_PRIVATE ?? (await this.d.secrets.get('vapid.private'));
    if (pub && priv) return (this.vapid = { publicKey: pub, privateKey: priv });
    const k = webpush.generateVAPIDKeys();
    await this.d.secrets.set('vapid.public', k.publicKey);
    await this.d.secrets.set('vapid.private', k.privateKey);
    return (this.vapid = k);
  }

  async prefs(): Promise<NotificationPrefs> {
    return PrefsSchema.parse((await this.d.settings.get('notification_prefs')) ?? {});
  }

  async setPrefs(patch: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
    const next = PrefsSchema.parse({ ...(await this.prefs()), ...patch });
    await this.d.settings.set('notification_prefs', next);
    return next;
  }

  async subscriptions(): Promise<PushSub[]> {
    return (await this.d.settings.get<PushSub[]>('push_subscriptions')) ?? [];
  }

  async subscribe(sub: z.infer<typeof PushSubscriptionSchema>, label?: string): Promise<void> {
    const parsed = PushSubscriptionSchema.parse(sub);
    const subs = (await this.subscriptions()).filter((s) => s.endpoint !== parsed.endpoint);
    subs.push({ ...parsed, label, createdAt: this.d.clock.now().toISOString() });
    await this.d.settings.set('push_subscriptions', subs);
    this.d.audit.record('bruno', 'push.subscribed', undefined, { label });
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.d.settings.set('push_subscriptions', (await this.subscriptions()).filter((s) => s.endpoint !== endpoint));
  }

  async nativeSubscriptions(): Promise<NativeSub[]> {
    const subs = await this.d.settings.get<NativeSub[]>('native_push_subscriptions') ?? [];
    return subs.filter(s => new Date(s.expiresAt).getTime() > this.d.clock.now().getTime());
  }

  async subscribeNative(token: string, deviceId: string, expiresAt: Date): Promise<void> {
    NativePushTokenSchema.parse(token);
    await this.nativeMutex.run('subscriptions', async () => {
      const subs = (await this.nativeSubscriptions()).filter(s => s.deviceId !== deviceId && s.token !== token);
      subs.push({ token, deviceId, expiresAt: expiresAt.toISOString() });
      await this.d.settings.set('native_push_subscriptions', subs);
    });
  }

  async unsubscribeNative(deviceId: string): Promise<void> {
    await this.removeNative(s => s.deviceId === deviceId);
  }

  private async removeNative(remove: (sub: NativeSub) => boolean): Promise<void> {
    await this.nativeMutex.run('subscriptions', async () => {
      await this.d.settings.set('native_push_subscriptions', (await this.nativeSubscriptions()).filter(s => !remove(s)));
    });
  }

  private async expoRequest(path: string, body: unknown): Promise<any> {
    const accessToken = process.env.JENNIFER_EXPO_ACCESS_TOKEN;
    const response = await fetch(`https://exp.host/--/api/v2/push/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Native notification service unavailable');
    return response.json();
  }

  /** Called by the existing minute timer; tickets are not proof of device delivery. */
  async checkNativeReceipts(): Promise<void> {
    const pending = await this.d.settings.get<Array<{ id: string; token: string; at: number }>>('native_push_receipts') ?? [];
    const now = this.d.clock.now().getTime();
    const ready = pending.filter(r => now - r.at >= 15 * 60_000).slice(0, 1000);
    if (!ready.length) return;
    const result = await this.expoRequest('getReceipts', { ids: ready.map(r => r.id) });
    const done = new Set<string>();
    for (const receipt of ready) {
      const status = result.data?.[receipt.id];
      if (status?.details?.error === 'DeviceNotRegistered') {
        // A rotated token must not be removed by a receipt for the old token.
        await this.removeNative(s => s.token === receipt.token);
      }
      if (status || now - receipt.at > 24 * 3600_000) done.add(receipt.id);
    }
    // Preserve tickets added while the receipt request was in flight.
    await this.nativeMutex.run('receipts', async () => {
      const latest = await this.d.settings.get<typeof pending>('native_push_receipts') ?? [];
      await this.d.settings.set('native_push_receipts', latest.filter(r => !done.has(r.id)));
    });
  }

  private async deliverNative(n: Notice, p: NotificationPrefs): Promise<number> {
    let accepted = 0;
    for (const sub of await this.nativeSubscriptions()) {
      try {
        if (!(await this.nativeDeviceActive(sub.deviceId))) {
          await this.unsubscribeNative(sub.deviceId);
          continue;
        }
        const result = await this.expoRequest('send', {
          to: sub.token, title: n.title, body: p.showDetails && n.detail ? n.detail : n.body,
          data: { url: n.url }, sound: 'default', channelId: 'jennifer',
          ttl: n.urgent ? 3600 : 6 * 3600, priority: n.urgent ? 'high' : 'normal',
        });
        const ticket = result.data;
        if (ticket?.status === 'ok' && typeof ticket.id === 'string') {
          await this.nativeMutex.run('receipts', async () => {
            const pending = await this.d.settings.get<Array<{ id: string; token: string; at: number }>>('native_push_receipts') ?? [];
            pending.push({ id: ticket.id, token: sub.token, at: this.d.clock.now().getTime() });
            await this.d.settings.set('native_push_receipts', pending.slice(-10000));
          });
          accepted++;
        } else if (ticket?.details?.error === 'DeviceNotRegistered') {
          await this.removeNative(s => s.token === sub.token);
        }
      } catch { /* Preserve the subscription for transient failures; urgent fallback still runs. */ }
    }
    return accepted;
  }

  isQuiet(p: NotificationPrefs, at = this.d.clock.now()): boolean {
    const local = DateTime.fromJSDate(at, { zone: p.timeZone });
    const mins = local.hour * 60 + local.minute;
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const s = toMin(p.quietStart);
    const e = toMin(p.quietEnd);
    return s <= e ? mins >= s && mins < e : mins >= s || mins < e;
  }

  /** Returns what happened, for logging and tests. */
  async notify(n: Notice): Promise<'sent' | 'held' | 'duplicate' | 'disabled' | 'no_devices'> {
    const p = await this.prefs();
    if (!p.enabled || !p.kinds[n.kind]) return 'disabled';
    const now = this.d.clock.now().getTime();
    const last = this.sentKeys.get(n.dedupKey);
    if (last && now - last < DEDUP_MS) return 'duplicate';
    this.sentKeys.set(n.dedupKey, now);
    if (!n.urgent && this.isQuiet(p)) {
      this.held.push(n);
      return 'held';
    }
    const result = await this.deliver(n, p);
    if (result === 'no_devices') this.sentKeys.delete(n.dedupKey);
    return result;
  }

  /** After quiet hours: one summary instead of a burst. */
  async flushHeld(): Promise<number> {
    const p = await this.prefs();
    if (this.held.length === 0 || this.isQuiet(p)) return 0;
    const items = this.held.splice(0);
    const counts = items.reduce<Record<string, number>>((acc, i) => ((acc[i.kind] = (acc[i.kind] ?? 0) + 1), acc), {});
    const parts = Object.entries(counts).map(([k, v]) => `${v} ${k === 'decision' ? 'decision' : k === 'mission' ? 'mission update' : k === 'problem' ? 'problem' : k === 'call' ? 'call message' : 'message'}${v > 1 ? 's' : ''}`);
    await this.deliver({ kind: 'decision', title: 'Jennifer: while you were resting', body: parts.join(', '), url: '/', dedupKey: `digest:${this.d.clock.now().toISOString()}` }, p);
    return items.length;
  }

  private async deliver(n: Notice, p: NotificationPrefs): Promise<'sent' | 'no_devices'> {
    const subs = await this.subscriptions();
    // Urgent items reach Bruno even without a working push subscription (configurable fallback channel, spec §16).
    const fallback = async (): Promise<'sent' | 'no_devices'> => {
      if (!n.urgent || !this.d.fallback) return 'no_devices';
      try {
        await this.d.fallback(n, `${n.title}: ${p.showDetails && n.detail ? n.detail : n.body}`);
        return 'sent';
      } catch {
        return 'no_devices';
      }
    };
    const nativeAccepted = await this.deliverNative(n, p);
    if (subs.length === 0) return nativeAccepted ? 'sent' : fallback();
    const keys = await this.keys();
    const payload = JSON.stringify({ title: n.title, body: p.showDetails && n.detail ? n.detail : n.body, url: n.url, tag: n.dedupKey });
    const send: PushSender = this.d.send ?? ((sub, data, opts) => webpush.sendNotification(sub, data, opts));
    const dead: string[] = [];
    let delivered = nativeAccepted;
    for (const sub of subs) {
      try {
        await send(sub, payload, { TTL: n.urgent ? 3600 : 6 * 3600, urgency: n.urgent ? 'high' : 'normal', vapidDetails: { subject: this.d.subject, ...keys } });
        delivered++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(sub.endpoint); // subscription expired or app removed
      }
    }
    for (const ep of dead) await this.unsubscribe(ep);
    return delivered ? 'sent' : fallback();
  }
}
