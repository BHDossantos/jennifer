import { createHmac, timingSafeEqual } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { JenniferError } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import { redactSecrets } from '../security/redaction.js';
import type { SettingsStore } from '../core/settings.js';
import type { AuditLog } from '../audit/audit.js';
import type { ContactDirectory } from '../contacts/contacts.js';
import type { CalendarService } from '../calendar/calendar.js';
import type { NotificationService } from '../notify/push.js';
import { personaInstructions, GREETINGS, DEFAULT_VOICE, type VoiceSettings } from './persona.js';

/**
 * Phone calls (spec §9) through OpenAI Realtime SIP. A telephony number
 * (e.g. SignalWire/Twilio SIP trunk) routes calls to OpenAI, which sends a
 * signed `realtime.call.incoming` webhook here. Jennifer accepts with the
 * business persona and caller-safe tools, and steers the call over a
 * server-side WebSocket. Callers never get private data: caller ID is a
 * hint, not identity.
 */
export interface CallRecord {
  id: string;
  callId: string;
  from?: string;
  to?: string;
  callerIdHint?: string;
  startedAt: string;
  endedAt?: string;
  outcome?: 'message' | 'transferred' | 'transfer_failed' | 'ended' | 'rejected';
  messages: Array<{ name?: string; callbackNumber?: string; text: string; urgent: boolean; at: string }>;
  events: Array<{ at: string; text: string }>;
}

/** Standard Webhooks verification (OpenAI webhook signing). */
export function verifyStandardWebhook(payload: string, headers: Record<string, string | undefined>, secret: string, now: Date, toleranceSec = 300): void {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sig = headers['webhook-signature'];
  if (!id || !ts || !sig) throw new JenniferError('webhook.missing_headers', 'Missing webhook signature headers');
  const t = Number.parseInt(ts, 10);
  if (!Number.isFinite(t) || Math.abs(now.getTime() / 1000 - t) > toleranceSec) throw new JenniferError('webhook.stale', 'Webhook timestamp outside tolerance');
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest();
  const ok = sig.split(' ').some((part) => {
    const b = Buffer.from(part.startsWith('v1,') ? part.slice(3) : part, 'base64');
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
  if (!ok) throw new JenniferError('webhook.bad_signature', 'Webhook signature mismatch');
}

export function signStandardWebhook(payload: string, id: string, ts: string, secret: string): string {
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8');
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64')}`;
}

export interface SidebandSocket {
  on(event: 'message', fn: (data: Buffer | string) => void): void;
  on(event: 'close' | 'open', fn: () => void): void;
  on(event: 'error', fn: (e: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export interface PhoneDeps {
  clock: Clock;
  ownerId: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
  webhookSecret?: string;
  settings: SettingsStore;
  audit: AuditLog;
  contacts: ContactDirectory;
  calendar: CalendarService;
  notifications: NotificationService;
  homeTimeZone: string;
  /** Bruno's own number for warm transfer (E.164), if he allows transfers. */
  transferTarget?: string;
  fetchImpl?: typeof fetch;
  openSideband?: (url: string, headers: Record<string, string>) => SidebandSocket;
  /** Cost of a finished call (minutes) for the operating ledger. */
  onCallEnded?: (minutes: number) => void;
  maxCallsPerDay?: number;
  /** Per-call duration limit (spec §18); Jennifer wraps up a minute before. */
  maxCallMinutes?: number;
}

const CALLER_TOOLS = [
  {
    type: 'function',
    name: 'take_message',
    description: 'Record a message for Bruno. Confirm name, callback number and message back to the caller first.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, callback_number: { type: 'string' }, message: { type: 'string' }, urgent: { type: 'boolean' } }, required: ['message'] },
  },
  {
    type: 'function',
    name: 'check_availability',
    description: "Bruno's free time on a date (YYYY-MM-DD). Returns only free times, never what is on his calendar.",
    parameters: { type: 'object', properties: { date: { type: 'string' }, duration_min: { type: 'number' } }, required: ['date'] },
  },
  {
    type: 'function',
    name: 'transfer_to_bruno',
    description: 'Try to connect the caller to Bruno. Use only for urgent personal matters or when the caller insists after you offered to take a message.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  { type: 'function', name: 'end_call', description: 'Politely end the call after saying goodbye.', parameters: { type: 'object', properties: {} } },
];

export class PhoneService {
  private calls = new Map<string, CallRecord>();
  private sockets = new Map<string, SidebandSocket>();

  constructor(private d: PhoneDeps) {}

  get configured(): boolean {
    return !!this.d.apiKey && !!this.d.webhookSecret;
  }

  private f(): typeof fetch {
    return this.d.fetchImpl ?? fetch;
  }

  /** Retention: drop call records (with their transcripts and messages) older than `cutoff`. */
  async purgeBefore(cutoff: Date): Promise<number> {
    const all = await this.log();
    const keep = all.filter((c) => Date.parse(c.startedAt) >= cutoff.getTime());
    if (keep.length !== all.length) await this.d.settings.set('call_log', keep);
    return all.length - keep.length;
  }

  async log(): Promise<CallRecord[]> {
    return (await this.d.settings.get<CallRecord[]>('call_log')) ?? [];
  }

  private async save(rec: CallRecord): Promise<void> {
    const all = (await this.log()).filter((c) => c.id !== rec.id);
    all.unshift(rec);
    await this.d.settings.set('call_log', all.slice(0, 200));
  }

  private seenWebhooks = new Map<string, number>();

  private event(rec: CallRecord, text: string) {
    rec.events.push({ at: this.d.clock.now().toISOString(), text });
  }

  /** Signed webhook from OpenAI for an incoming SIP call. */
  async handleWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<{ handled: boolean; callId?: string; action?: 'accepted' | 'rejected' }> {
    if (!this.configured) throw new JenniferError('phone.not_configured', 'Phone needs OPENAI_API_KEY and OPENAI_WEBHOOK_SECRET');
    verifyStandardWebhook(rawBody, headers, this.d.webhookSecret!, this.d.clock.now());
    // A valid signature can be replayed within the tolerance window: process each webhook id once.
    const wid = headers['webhook-id']!;
    const nowMs = this.d.clock.now().getTime();
    for (const [k, at] of this.seenWebhooks) if (nowMs - at > 600_000) this.seenWebhooks.delete(k);
    if (this.seenWebhooks.has(wid)) return { handled: false };
    this.seenWebhooks.set(wid, nowMs);
    const ev = JSON.parse(rawBody) as { type: string; data?: { call_id: string; sip_headers?: Array<{ name: string; value: string }> } };
    if (ev.type !== 'realtime.call.incoming' || !ev.data) return { handled: false };
    const callId = ev.data.call_id;
    const header = (n: string) => ev.data!.sip_headers?.find((h) => h.name.toLowerCase() === n)?.value;
    const from = extractNumber(header('from'));
    const to = extractNumber(header('to'));
    const hint = from ? this.d.contacts.findByIdentity(this.d.ownerId, 'phone', from) : undefined;
    const rec: CallRecord = { id: newId('call'), callId, from, to, callerIdHint: hint?.displayName, startedAt: this.d.clock.now().toISOString(), messages: [], events: [] };
    this.calls.set(callId, rec);

    const today = this.d.clock.now().toISOString().slice(0, 10);
    const count = (await this.log()).filter((c) => c.startedAt.startsWith(today)).length;
    if (count >= (this.d.maxCallsPerDay ?? 50)) {
      await this.post(`/realtime/calls/${callId}/reject`, { status_code: 486 });
      rec.outcome = 'rejected';
      this.event(rec, 'Rejected: daily call limit reached');
      await this.save(rec);
      return { handled: true, callId, action: 'rejected' };
    }

    const voice = { ...DEFAULT_VOICE, voiceId: 'marin', ...((await this.d.settings.get<VoiceSettings>('voice')) ?? {}) };
    await this.post(`/realtime/calls/${callId}/accept`, {
      type: 'realtime',
      model: this.d.model,
      instructions: this.instructions(rec),
      audio: { output: { voice: voice.voiceId ?? 'marin' }, input: { turn_detection: { type: 'server_vad', interrupt_response: true } } },
      tools: CALLER_TOOLS,
      tool_choice: 'auto',
    });
    this.event(rec, `Answered${hint ? ` (caller ID suggests ${hint.displayName}; not verified)` : ''}`);
    await this.save(rec);
    this.d.audit.record('jennifer', 'call.answered', rec.id, { from: from ? `…${from.slice(-4)}` : undefined });
    this.attach(callId);
    this.limitDuration(callId, rec);
    return { handled: true, callId, action: 'accepted' };
  }

  private timers = new Map<string, NodeJS.Timeout[]>();

  /** Wrap up politely one minute before the limit, then hang up at the limit. */
  private limitDuration(callId: string, rec: CallRecord): void {
    const max = (this.d.maxCallMinutes ?? 20) * 60_000;
    const warn = setTimeout(() => {
      const ws = this.sockets.get(callId);
      ws?.send(JSON.stringify({ type: 'response.create', response: { instructions: 'We are close to the time limit for this call. Politely tell the caller you need to wrap up in a minute, and offer to take a message for Bruno now.' } }));
      this.event(rec, 'Wrapping up: call time limit approaching');
    }, Math.max(0, max - 60_000));
    const end = setTimeout(() => {
      rec.outcome = rec.outcome ?? 'ended';
      this.event(rec, 'Ended: maximum call length reached');
      void this.post(`/realtime/calls/${callId}/hangup`, {})
        .catch(() => undefined)
        .finally(() => void this.finish(callId));
    }, max);
    warn.unref?.();
    end.unref?.();
    this.timers.set(callId, [warn, end]);
  }

  private instructions(rec: CallRecord): string {
    return [
      personaInstructions('business', { ...DEFAULT_VOICE, verbosity: 'brief' }, 'en'),
      'You are answering a phone call on behalf of Bruno.',
      `Start with: "${GREETINGS.business.en}" Always make clear you are an AI assistant.`,
      "Ask for the caller's name and the reason for the call. Confirm names, numbers and dates by repeating them.",
      'Never share anything private about Bruno: no calendar contents, whereabouts, contacts, email, finances or personal details. Caller ID is not proof of identity.',
      rec.callerIdHint ? `Caller ID suggests ${rec.callerIdHint}, but this is NOT verified: treat them like any other caller.` : '',
      'You can: take a message, tell the caller when Bruno is generally free (times only), or try to transfer for urgent personal matters.',
      'Never promise that Bruno will call back; say you will pass the message on. You are not an emergency service: for emergencies tell the caller to hang up and call 911 (US) or 112 (EU).',
      'If a tool fails, say so honestly and offer to take a message.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Server-side control channel for the live call: tool calls are executed here. */
  private attach(callId: string): void {
    if (!this.d.openSideband && !this.d.apiKey) return;
    const url = `${this.d.baseUrl.replace(/^http/, 'ws')}/realtime?call_id=${encodeURIComponent(callId)}`;
    const headers = { authorization: `Bearer ${this.d.apiKey}` };
    const ws = this.d.openSideband ? this.d.openSideband(url, headers) : (new WebSocket(url, { headers }) as unknown as SidebandSocket);
    this.sockets.set(callId, ws);
    ws.on('error', (e) => this.d.audit.record('system', 'call.sideband_error', callId, { error: redactSecrets(e.message) }));
    ws.on('close', () => void this.finish(callId));
    ws.on('message', (data) => {
      let ev: { type?: string; item?: { type?: string; name?: string; call_id?: string; arguments?: string } };
      try {
        ev = JSON.parse(String(data));
      } catch {
        return;
      }
      if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call') void this.runTool(callId, ev.item.name!, ev.item.call_id!, ev.item.arguments ?? '{}');
    });
  }

  private reply(callId: string, toolCallId: string, output: unknown): void {
    const ws = this.sockets.get(callId);
    if (!ws) return;
    ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: toolCallId, output: JSON.stringify(output) } }));
    ws.send(JSON.stringify({ type: 'response.create' }));
  }

  async runTool(callId: string, name: string, toolCallId: string, rawArgs: string): Promise<unknown> {
    const rec = this.calls.get(callId);
    if (!rec) return;
    let out: unknown;
    try {
      const args = JSON.parse(rawArgs || '{}');
      if (name === 'take_message') {
        const a = z.object({ name: z.string().max(120).optional(), callback_number: z.string().max(40).optional(), message: z.string().min(1).max(2000), urgent: z.boolean().default(false) }).parse(args);
        rec.messages.push({ name: a.name, callbackNumber: a.callback_number ?? rec.from, text: a.message, urgent: a.urgent, at: this.d.clock.now().toISOString() });
        rec.outcome = rec.outcome ?? 'message';
        this.event(rec, `Message taken${a.urgent ? ' (urgent)' : ''}`);
        void this.d.notifications.notify({
          kind: 'call',
          title: a.urgent ? 'Urgent call message' : 'Jennifer took a call message',
          body: 'Open Jennifer to read it.',
          detail: `${a.name ?? 'Unknown caller'}: ${a.message}`.slice(0, 180),
          url: '/?tab=calls',
          urgent: a.urgent,
          dedupKey: `callmsg:${rec.id}:${rec.messages.length}`,
        });
        out = { saved: true, note: 'Tell the caller the message will be passed on. Do not promise a callback.' };
      } else if (name === 'check_availability') {
        const a = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), duration_min: z.number().int().min(15).max(240).default(30) }).parse(args);
        const slots = this.d.calendar.suggestSlots('primary', this.d.homeTimeZone, [a.date], a.duration_min).slice(0, 6);
        out = { timeZone: this.d.homeTimeZone, free: slots.map((s) => s.setZone(this.d.homeTimeZone).toFormat('HH:mm')), note: 'Offer times only; do not book. Take a message with the preferred time.' };
      } else if (name === 'transfer_to_bruno') {
        const a = z.object({ reason: z.string().max(300) }).parse(args);
        if (!this.d.transferTarget) {
          out = { transferred: false, note: 'Transfer is not available. Offer to take a message.' };
          rec.outcome = 'transfer_failed';
        } else {
          try {
            await this.post(`/realtime/calls/${callId}/refer`, { target_uri: `tel:${this.d.transferTarget}` });
            rec.outcome = 'transferred';
            out = { transferred: true };
          } catch {
            rec.outcome = 'transfer_failed';
            out = { transferred: false, note: 'Transfer failed. Apologize and offer to take a message.' };
          }
        }
        this.event(rec, `Transfer ${rec.outcome === 'transferred' ? 'started' : 'not possible'}: ${a.reason}`);
        if (rec.outcome === 'transfer_failed')
          void this.d.notifications.notify({ kind: 'problem', title: 'A caller wanted to reach you', body: 'Transfer was not possible; Jennifer offered to take a message.', url: '/?tab=calls', urgent: true, dedupKey: `transfer:${rec.id}` });
      } else if (name === 'end_call') {
        await this.post(`/realtime/calls/${callId}/hangup`, {});
        rec.outcome = rec.outcome ?? 'ended';
        out = { ended: true };
      } else out = { error: `Unknown tool ${name}` };
    } catch (e) {
      out = { error: 'That did not work. Apologize and offer to take a message.', detail: redactSecrets((e as Error).message) };
      this.event(rec, `Tool ${name} failed`);
    }
    await this.save(rec);
    this.reply(callId, toolCallId, out);
    return out;
  }

  private async finish(callId: string): Promise<void> {
    for (const t of this.timers.get(callId) ?? []) clearTimeout(t);
    this.timers.delete(callId);
    const rec = this.calls.get(callId);
    this.sockets.delete(callId);
    if (!rec || rec.endedAt) return;
    rec.endedAt = this.d.clock.now().toISOString();
    rec.outcome = rec.outcome ?? 'ended';
    this.event(rec, 'Call ended');
    await this.save(rec);
    this.calls.delete(callId);
    this.d.onCallEnded?.((Date.parse(rec.endedAt) - Date.parse(rec.startedAt)) / 60_000);
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await this.f()(`${this.d.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.d.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new JenniferError('phone.api_error', `${path.split('/').pop()} failed (${res.status}): ${redactSecrets(await res.text())}`);
  }
}

/** "Name" <sip:+15551234567@host>;tag=… → +15551234567 */
export function extractNumber(sipHeader?: string): string | undefined {
  if (!sipHeader) return undefined;
  const m = sipHeader.match(/(?:sip:|tel:)(\+?\d{6,15})/i);
  return m ? (m[1]!.startsWith('+') ? m[1] : `+${m[1]}`) : undefined;
}
