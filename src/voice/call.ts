import { type Clock, newId } from '../core/util.js';
import type { ContactDirectory } from '../contacts/contacts.js';
import { GREETINGS, type VoiceLanguage } from './persona.js';

/**
 * Inbound call handling state machine (spec §9). Transport (SIP → realtime
 * voice session) is handled by the voice gateway; this module holds the
 * decisions: disclosure, caller identification, scope, transfer and
 * message-taking fallback.
 */
export type CallPhase = 'ringing' | 'disclosed' | 'collecting' | 'handling' | 'transferring' | 'taking_message' | 'ended';

export interface CallSession {
  id: string;
  ownerId: string;
  dialedAccountId: string;
  callerNumber?: string;
  /** Caller ID is a hint, never identity proof. */
  callerIdHintContactId?: string;
  callerName?: string;
  purpose?: string;
  verified: boolean;
  phase: CallPhase;
  language: VoiceLanguage;
  transcript: Array<{ at: Date; speaker: 'caller' | 'jennifer' | 'system'; text: string }>;
  recording: boolean;
  summary?: string;
  followUpTaskId?: string;
  startedAt: Date;
  endedAt?: Date;
}

export interface FollowUpTask {
  id: string;
  callId: string;
  kind: 'message_for_bruno' | 'transfer_failed' | 'urgent_escalation';
  summary: string;
  createdAt: Date;
}

export interface TransferPort {
  /** Warm transfer with context; resolves false on failure or no answer. */
  warmTransfer(callId: string, target: string, context: string): Promise<boolean>;
}

export interface SpeechOutput {
  speak(text: string): void;
  stop(): void;
  readonly speaking: boolean;
}

/** Barge-in: caller speech stops Jennifer's playback immediately. */
export class InterruptibleSpeech implements SpeechOutput {
  private queue: string[] = [];
  private current?: string;
  readonly spoken: string[] = [];
  readonly interrupted: string[] = [];

  get speaking(): boolean {
    return !!this.current;
  }
  speak(text: string): void {
    if (this.current) this.queue.push(text);
    else this.current = text;
  }
  /** Simulate playback completing. */
  finishCurrent(): void {
    if (this.current) this.spoken.push(this.current);
    this.current = this.queue.shift();
  }
  stop(): void {
    if (this.current) this.interrupted.push(this.current);
    this.current = undefined;
    this.queue = [];
  }
}

export class CallHandler {
  private sessions = new Map<string, CallSession>();
  readonly followUps: FollowUpTask[] = [];

  constructor(
    private clock: Clock,
    private contacts: ContactDirectory,
    private transfer: TransferPort,
    private speech: SpeechOutput,
    private opts: { ownerId: string; transferTarget?: string; recordByDefault?: boolean } = { ownerId: 'bruno' },
  ) {}

  incoming(dialedAccountId: string, callerNumber: string | undefined, language: VoiceLanguage = 'en'): CallSession {
    const hint = callerNumber ? this.contacts.findByIdentity(this.opts.ownerId, 'phone', callerNumber) : undefined;
    const s: CallSession = {
      id: newId('call'),
      ownerId: this.opts.ownerId,
      dialedAccountId,
      callerNumber,
      callerIdHintContactId: hint?.id,
      verified: false,
      phase: 'ringing',
      language,
      transcript: [],
      recording: this.opts.recordByDefault ?? false,
      startedAt: this.clock.now(),
    };
    this.sessions.set(s.id, s);
    // Always disclose AI assistance first.
    this.say(s, GREETINGS.business[language]);
    s.phase = 'disclosed';
    return s;
  }

  get(id: string): CallSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`No call ${id}`);
    return s;
  }

  /** Caller speaks. Any speech while Jennifer is talking interrupts her. */
  callerSaid(id: string, text: string): void {
    const s = this.get(id);
    if (this.speech.speaking) this.speech.stop();
    s.transcript.push({ at: this.clock.now(), speaker: 'caller', text });
  }

  identify(id: string, name: string, purpose: string): void {
    const s = this.get(id);
    s.callerName = name;
    s.purpose = purpose;
    s.phase = 'handling';
    this.say(s, `Thank you, ${name}. Let me confirm: you're calling about ${purpose}.`);
  }

  /** Separate verification (e.g. code sent to verified email) before sensitive matters. */
  markVerified(id: string): void {
    this.get(id).verified = true;
  }

  /** Context allowed for this caller: nothing private unless verified. */
  mayDiscuss(id: string, sensitivity: 'public' | 'caller_specific' | 'private'): boolean {
    const s = this.get(id);
    if (sensitivity === 'public') return true;
    if (sensitivity === 'caller_specific') return s.verified && !!s.callerIdHintContactId;
    return false; // private matters are never discussed with callers
  }

  /** A tool failed mid-call: say so honestly. */
  toolFailed(id: string, what: string): void {
    this.say(this.get(id), `I'm sorry, I couldn't ${what} just now. I can take a message so Bruno gets it.`);
  }

  async requestTransfer(id: string, urgent = false): Promise<'transferred' | 'message_taking'> {
    const s = this.get(id);
    if (!this.opts.transferTarget) return this.fallbackToMessage(s, 'no transfer target configured', urgent);
    s.phase = 'transferring';
    this.say(s, 'One moment, I will try to connect you with Bruno.');
    const ctx = `${s.callerName ?? 'Unknown caller'} (${s.verified ? 'verified' : 'unverified'}) about ${s.purpose ?? 'unspecified'}`;
    let ok = false;
    try {
      ok = await this.transfer.warmTransfer(id, this.opts.transferTarget, ctx);
    } catch {
      ok = false;
    }
    if (ok) {
      s.phase = 'ended';
      s.endedAt = this.clock.now();
      return 'transferred';
    }
    return this.fallbackToMessage(s, 'transfer failed', urgent);
  }

  takeMessage(id: string, message: string): FollowUpTask {
    const s = this.get(id);
    const task: FollowUpTask = {
      id: newId('fu'),
      callId: id,
      kind: 'message_for_bruno',
      summary: `${s.callerName ?? 'Unknown caller'} (${s.callerNumber ?? 'no caller ID'}): ${message}`,
      createdAt: this.clock.now(),
    };
    this.followUps.push(task);
    s.followUpTaskId = task.id;
    // No promise of a callback unless a task has been accepted.
    this.say(s, "I've recorded your message for Bruno.");
    return task;
  }

  end(id: string): CallSession {
    const s = this.get(id);
    s.phase = 'ended';
    s.endedAt = this.clock.now();
    s.summary = `Caller: ${s.callerName ?? 'unknown'}; purpose: ${s.purpose ?? 'unknown'}; verified: ${s.verified}; follow-up: ${s.followUpTaskId ?? 'none'}`;
    return s;
  }

  private fallbackToMessage(s: CallSession, reason: string, urgent: boolean): 'message_taking' {
    s.phase = 'taking_message';
    this.followUps.push({
      id: newId('fu'),
      callId: s.id,
      kind: urgent ? 'urgent_escalation' : 'transfer_failed',
      summary: `${reason}: ${s.callerName ?? 'Unknown caller'} about ${s.purpose ?? 'unspecified'}`,
      createdAt: this.clock.now(),
    });
    this.say(s, "I wasn't able to connect you right now. May I take a message for Bruno?");
    return 'message_taking';
  }

  private say(s: CallSession, text: string): void {
    s.transcript.push({ at: this.clock.now(), speaker: 'jennifer', text });
    this.speech.speak(text);
  }
}
