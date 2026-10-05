import { JenniferError } from '../core/types.js';
import { redactSecrets } from '../security/redaction.js';
import { deliveryDirection } from './realtime.js';
import type { DeliveryMode, VoiceSettings } from './persona.js';
import type { ElevenLabsTTS } from './elevenlabs.js';

/**
 * Chained voice pipeline (spec §8): speech recognition → Jennifer's text
 * reasoning (the same chat service, tools and policy) → speech synthesis.
 * Slower than realtime speech-to-speech, but every turn has an exact
 * transcript and the pronunciation dictionary is applied before synthesis.
 */
export interface ChainedTurn {
  transcript: string;
  reply: string;
  audio: Buffer;
  timingsMs: { asr: number; think: number; tts: number; total: number };
}

/** Whole-word, case-insensitive replacements so names are spoken right (e.g. "Bianchi" → "Bee-AHN-kee"). */
export function applyPronunciations(text: string, dict: Record<string, string>): string {
  let out = text;
  for (const [word, say] of Object.entries(dict).sort((a, b) => b[0].length - a[0].length)) {
    if (!word.trim()) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
    out = out.replace(re, say);
  }
  return out;
}

export class ChainedVoice {
  constructor(
    private cfg: { apiKey?: string; baseUrl: string; asrModel?: string; ttsModel?: string; fetchImpl?: typeof fetch; now?: () => number; elevenlabs?: ElevenLabsTTS },
  ) {}

  private f() {
    return this.cfg.fetchImpl ?? fetch;
  }

  private key(): string {
    if (!this.cfg.apiKey) throw new JenniferError('voice.not_configured', 'Set OPENAI_API_KEY on the server to enable voice');
    return this.cfg.apiKey;
  }

  async transcribe(audio: Buffer, mime: string, language?: string): Promise<string> {
    const form = new FormData();
    const ext = mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('wav') ? 'wav' : mime.includes('mpeg') ? 'mp3' : 'webm';
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `turn.${ext}`);
    form.append('model', this.cfg.asrModel ?? 'gpt-4o-transcribe');
    if (language) form.append('language', language.slice(0, 2));
    const res = await this.f()(`${this.cfg.baseUrl}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${this.key()}` }, body: form });
    if (!res.ok) throw new JenniferError('voice.asr_failed', `Transcription failed (${res.status}): ${redactSecrets(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { text?: string }).text?.trim() ?? '';
  }

  /** True when replies will be spoken by ElevenLabs for these settings. */
  usesElevenLabs(settings: VoiceSettings): boolean {
    return settings.ttsProvider === 'elevenlabs' && !!settings.elevenVoiceId && !!this.cfg.elevenlabs?.configured;
  }

  async speak(text: string, voice: string, mode: DeliveryMode, settings: VoiceSettings): Promise<Buffer> {
    if (this.usesElevenLabs(settings)) {
      return this.cfg.elevenlabs!.speak(applyPronunciations(text, settings.pronunciations ?? {}), settings.elevenVoiceId!, mode, settings);
    }
    const res = await this.f()(`${this.cfg.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.ttsModel ?? 'gpt-4o-mini-tts',
        voice,
        input: applyPronunciations(text, settings.pronunciations ?? {}).slice(0, 4000),
        instructions: deliveryDirection(mode, settings),
        response_format: 'mp3',
        speed: settings.speakingRate,
      }),
    });
    if (!res.ok) throw new JenniferError('voice.tts_failed', `Speech failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** One push-to-talk turn. `think` is Jennifer's chat (same tools, policy and memory rules). */
  async turn(input: { audio: Buffer; mime: string; language?: string; voice: string; mode: DeliveryMode; settings: VoiceSettings }, think: (text: string) => Promise<string>): Promise<ChainedTurn> {
    const now = this.cfg.now ?? Date.now;
    const t0 = now();
    const transcript = await this.transcribe(input.audio, input.mime, input.language);
    const t1 = now();
    if (!transcript) throw new JenniferError('voice.no_speech', "I didn't catch that. Could you say it again?");
    const reply = await think(transcript);
    const t2 = now();
    const audio = await this.speak(reply || "Sorry, I don't have an answer for that.", input.voice, input.mode, input.settings);
    const t3 = now();
    return { transcript, reply, audio, timingsMs: { asr: t1 - t0, think: t2 - t1, tts: t3 - t2, total: t3 - t0 } };
  }
}
