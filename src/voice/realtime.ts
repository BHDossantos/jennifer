import { JenniferError } from '../core/types.js';
import { redactSecrets } from '../security/redaction.js';
import { personaInstructions, VOICE_DIRECTION, ACCENT_DIRECTION, GREETINGS, type DeliveryMode, type VoiceLanguage, type VoiceSettings } from './persona.js';

/**
 * Jennifer's voice (spec §8). Realtime speech-to-speech over WebRTC: the
 * server mints a short-lived client secret with the session configured
 * server-side (model, voice, instructions, tools); the long-lived API key
 * never leaves the server. Tool calls the model makes during a voice
 * session are executed by the server through the normal tool registry.
 */
export interface VoiceCandidate {
  id: string; // provider preset name
  label: string;
  character: string;
}

/** Feminine preset voices to audition; Bruno picks by listening (spec §8). */
export const FEMALE_VOICE_CANDIDATES: VoiceCandidate[] = [
  { id: 'marin', label: 'Marin', character: "Natural and warm. OpenAI's recommended realtime voice." },
  { id: 'shimmer', label: 'Shimmer', character: 'Soft and smooth, lighter register.' },
  { id: 'coral', label: 'Coral', character: 'Bright and friendly, expressive.' },
  { id: 'sage', label: 'Sage', character: 'Calm and composed, lower energy.' },
];

export const DEFAULT_VOICE_ID = 'marin';

/** Style direction applied to speech (TTS instructions and realtime instructions). */
export function deliveryDirection(mode: DeliveryMode, s: Pick<VoiceSettings, 'warmth' | 'speakingRate' | 'playfulness' | 'accent'>): string {
  const pace = s.speakingRate < 0.95 ? 'unhurried' : s.speakingRate > 1.05 ? 'brisk' : 'relaxed';
  const accent = ACCENT_DIRECTION[s.accent ?? 'british'];
  if (mode === 'business') return `${VOICE_DIRECTION.business} ${accent} Pace: ${pace}.`;
  return `${VOICE_DIRECTION.private} ${accent} Lower, warm register; ${pace} pace; warmth ${s.warmth.toFixed(1)} of 1, playfulness ${s.playfulness.toFixed(1)} of 1. Speak to Bruno as a trusted, confident companion; never theatrical.`;
}

export interface VoiceToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  ttsModel?: string;
  fetchImpl?: typeof fetch;
}

export class RealtimeVoiceService {
  private audition = new Map<string, Buffer>();

  constructor(private cfg: RealtimeConfig) {}

  get configured(): boolean {
    return !!this.cfg.apiKey;
  }

  private f(): typeof fetch {
    return this.cfg.fetchImpl ?? fetch;
  }

  private key(): string {
    if (!this.cfg.apiKey) throw new JenniferError('voice.not_configured', 'Set OPENAI_API_KEY on the server to enable voice');
    return this.cfg.apiKey;
  }

  /** Mint an ephemeral client secret for one browser/iPhone WebRTC session. */
  async createSession(opts: { settings: VoiceSettings; mode: DeliveryMode; language: VoiceLanguage; tools: VoiceToolSpec[]; ttlSeconds?: number }) {
    const voice = opts.settings.voiceId ?? DEFAULT_VOICE_ID;
    const instructions = [
      personaInstructions(opts.mode, opts.settings, opts.language),
      `Voice delivery: ${deliveryDirection(opts.mode, opts.settings)}`,
      'You are speaking aloud: keep answers short and natural, no lists or markdown.',
      'Use tools for facts about Bruno’s day, inbox and decisions. Proposing a message never sends it: say it is waiting for his approval.',
      'If a tool is slow, say a brief "one moment" and do not pretend the work is done.',
      `Open with: "${GREETINGS[opts.mode][opts.language]}"`,
    ].join('\n');
    const body = {
      expires_after: { anchor: 'created_at', seconds: opts.ttlSeconds ?? 600 },
      session: {
        type: 'realtime',
        model: this.cfg.model,
        instructions,
        audio: {
          input: { turn_detection: { type: 'server_vad', interrupt_response: true, create_response: true } },
          output: { voice, speed: Math.min(1.25, Math.max(0.75, opts.settings.speakingRate)) },
        },
        tools: opts.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
        tool_choice: 'auto',
      },
    };
    const res = await this.f()(`${this.cfg.baseUrl}/realtime/client_secrets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new JenniferError('voice.session_failed', `Realtime session failed (${res.status}): ${redactSecrets(await res.text())}`);
    const json = (await res.json()) as { value: string; expires_at: number };
    return {
      clientSecret: json.value,
      expiresAt: new Date(json.expires_at * 1000).toISOString(),
      model: this.cfg.model,
      voice,
      callsUrl: `${this.cfg.baseUrl}/realtime/calls`,
    };
  }

  /** Spoken sample for the voice audition, cached per (voice, mode, language, settings). */
  async sample(voice: string, mode: DeliveryMode, language: VoiceLanguage, settings: VoiceSettings): Promise<Buffer> {
    if (!FEMALE_VOICE_CANDIDATES.some((c) => c.id === voice)) throw new JenniferError('voice.unknown', `Unknown voice ${voice}`);
    const cacheKey = `${voice}|${mode}|${language}|${settings.warmth}|${settings.speakingRate}|${settings.playfulness}|${settings.accent ?? "british"}`;
    const hit = this.audition.get(cacheKey);
    if (hit) return hit;
    const res = await this.f()(`${this.cfg.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.ttsModel ?? 'gpt-4o-mini-tts',
        voice,
        input: GREETINGS[mode][language],
        instructions: deliveryDirection(mode, settings),
        response_format: 'mp3',
        speed: settings.speakingRate,
      }),
    });
    if (!res.ok) throw new JenniferError('voice.sample_failed', `Voice sample failed (${res.status})`);
    const audio = Buffer.from(await res.arrayBuffer());
    this.audition.set(cacheKey, audio);
    return audio;
  }
}
