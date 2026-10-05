import { JenniferError } from '../core/types.js';
import { redactSecrets } from '../security/redaction.js';
import type { DeliveryMode, VoiceSettings } from './persona.js';

/**
 * ElevenLabs text-to-speech for Jennifer's licensed voice (spec §8: use a
 * licensed voice where voice character matters). Only ElevenLabs' own
 * library/premade voices or voices on Bruno's account are used; Jennifer
 * never clones a person's voice. The API key stays on the server.
 */
export interface ElevenVoice {
  voiceId: string;
  name: string;
  accent?: string;
  gender?: string;
  age?: string;
  description?: string;
  previewUrl?: string;
  category?: string;
}

/** Voices Bruno picked on elevenlabs.io; always offered, even before they are added to "My Voices". */
export const PINNED_VOICES: Array<{ voiceId: string; name: string; note: string }> = [
  { voiceId: 'LM5QaByxyWDmNhcQTYiS', name: 'Jennifer', note: 'your pick' },
];

/** Models with expressive audio tags ([soft], [whisper]...) and the coarse stability scale. */
export const isExpressiveModel = (model: string) => /^eleven_v[3-9]/.test(model);
const FALLBACK_MODEL = 'eleven_multilingual_v2';

export class ElevenLabsTTS {
  private modelRejected = false;
  private voiceCache?: { at: number; voices: ElevenVoice[] };
  private auditions = new Map<string, Buffer>();

  constructor(
    private c: { apiKey?: string; model?: string; baseUrl?: string; fetchImpl?: typeof fetch; /** Voice chosen on the server; usable even before it shows in the account's list. */ defaultVoiceId?: string },
  ) {}

  get configured(): boolean {
    return !!this.c.apiKey;
  }

  /** A voice Jennifer may speak with: on the account, or the server-configured choice. */
  async isAllowed(voiceId: string): Promise<boolean> {
    if (voiceId === this.c.defaultVoiceId || PINNED_VOICES.some((p) => p.voiceId === voiceId)) return true;
    return (await this.voices()).some((v) => v.voiceId === voiceId);
  }

  private base() {
    return this.c.baseUrl ?? 'https://api.elevenlabs.io';
  }

  private key(): string {
    if (!this.c.apiKey) throw new JenniferError('voice.elevenlabs_not_configured', 'Set ELEVENLABS_API_KEY on the server to use ElevenLabs voices');
    return this.c.apiKey;
  }

  /** Voices on the account, newest list cached for 10 minutes. */
  async voices(): Promise<ElevenVoice[]> {
    if (this.voiceCache && Date.now() - this.voiceCache.at < 600_000) return this.voiceCache.voices;
    const res = await (this.c.fetchImpl ?? fetch)(`${this.base()}/v1/voices`, { headers: { 'xi-api-key': this.key() } });
    if (res.status === 401) throw new JenniferError('voice.elevenlabs_auth', 'ElevenLabs rejected the API key');
    if (!res.ok) throw new JenniferError('voice.elevenlabs_error', `ElevenLabs voices failed (${res.status})`);
    const json = (await res.json()) as { voices?: Array<{ voice_id: string; name: string; category?: string; preview_url?: string; labels?: Record<string, string>; description?: string }> };
    const voices = (json.voices ?? []).map((v) => ({
      voiceId: v.voice_id,
      name: v.name,
      accent: v.labels?.accent,
      gender: v.labels?.gender,
      age: v.labels?.age,
      description: v.labels?.description ?? v.labels?.descriptive ?? v.description,
      previewUrl: v.preview_url,
      category: v.category,
    }));
    this.voiceCache = { at: Date.now(), voices };
    return voices;
  }

  /** Female voices with a British/English accent first, then the remaining female voices. */
  async britishFemale(): Promise<ElevenVoice[]> {
    const all = (await this.voices()).filter((v) => (v.gender ?? '').toLowerCase() === 'female');
    const british = (v: ElevenVoice) => /brit|english|uk|london|received/i.test(`${v.accent ?? ''} ${v.description ?? ''}`) && !/american|us\b/i.test(v.accent ?? '');
    return [...all.filter(british), ...all.filter((v) => !british(v))];
  }

  /** Jennifer's greeting in one of the account's voices, cached per voice and delivery. */
  async audition(voiceId: string, text: string, mode: DeliveryMode, s: Pick<VoiceSettings, 'warmth' | 'playfulness' | 'speakingRate'>): Promise<Buffer> {
    if (!(await this.isAllowed(voiceId))) throw new JenniferError('voice.unknown', 'That ElevenLabs voice is not on your account');
    const key = `${voiceId}|${mode}|${text}|${s.warmth}|${s.playfulness}|${s.speakingRate}`;
    const hit = this.auditions.get(key);
    if (hit) return hit;
    const audio = await this.speak(text, voiceId, mode, s);
    if (this.auditions.size > 100) this.auditions.clear();
    this.auditions.set(key, audio);
    return audio;
  }

  /**
   * Speak with the private/business delivery mapped onto ElevenLabs' voice
   * settings: lower stability and more style for the intimate private voice,
   * steadier and plainer for business. Uses eleven_v4 by default and falls
   * back to eleven_multilingual_v2 if the account can't use it.
   */
  get model(): string {
    return this.modelRejected ? FALLBACK_MODEL : (this.c.model ?? FALLBACK_MODEL);
  }

  /** Request body for a model: expressive models get a mood tag and the coarse stability scale. */
  body(text: string, mode: DeliveryMode, s: Pick<VoiceSettings, 'warmth' | 'playfulness' | 'speakingRate'>, model: string) {
    const priv = mode === 'private';
    if (isExpressiveModel(model)) {
      // Private: warm and intimate; business: composed. Tags steer delivery and are not spoken.
      const tag = priv ? (s.warmth >= 0.7 ? '[warm, intimate] ' : '[warm] ') : '[calm, professional] ';
      return { text: (/^\s*\[/.test(text) ? text : tag + text).slice(0, 5000), model_id: model, voice_settings: { stability: priv ? 0.5 : 1, similarity_boost: 0.8 } };
    }
    return {
      text: text.slice(0, 5000),
      model_id: model,
      voice_settings: {
        stability: priv ? Math.max(0.25, 0.5 - s.playfulness * 0.25) : 0.65,
        similarity_boost: 0.8,
        style: priv ? Math.min(0.7, 0.25 + s.warmth * 0.3 + s.playfulness * 0.15) : 0.1,
        use_speaker_boost: true,
        speed: Math.min(1.2, Math.max(0.7, s.speakingRate)),
      },
    };
  }

  async speak(text: string, voiceId: string, mode: DeliveryMode, s: Pick<VoiceSettings, 'warmth' | 'playfulness' | 'speakingRate'>): Promise<Buffer> {
    const post = (model: string) =>
      (this.c.fetchImpl ?? fetch)(`${this.base()}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': this.key(), 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify(this.body(text, mode, s, model)),
      });
    let res = await post(this.model);
    if ((res.status === 400 || res.status === 404 || res.status === 422) && this.model !== FALLBACK_MODEL) {
      const detail = await res.clone().text();
      // The account or region can't use the newest model yet: fall back once and remember.
      if (/model/i.test(detail) && !/voice/i.test(detail)) {
        this.modelRejected = true;
        res = await post(FALLBACK_MODEL);
      }
    }
    if (res.status === 401) throw new JenniferError('voice.elevenlabs_auth', 'ElevenLabs rejected the API key');
    if (res.status === 402) throw new JenniferError('voice.elevenlabs_plan', 'ElevenLabs needs a paid plan to use Voice Library voices through the API (Starter or above)');
    if (res.status === 404 || res.status === 400) {
      const body = redactSecrets(await res.text());
      if (/voice/i.test(body) && /not.?found|does not exist|not_found/i.test(body)) {
        throw new JenniferError('voice.elevenlabs_voice_missing', `ElevenLabs can't find voice ${voiceId}. Open elevenlabs.io/voices/${voiceId} and tap "Add to my voices", then try again`);
      }
      throw new JenniferError('voice.elevenlabs_error', `ElevenLabs speech failed (${res.status}): ${body.slice(0, 200)}`);
    }
    if (!res.ok) throw new JenniferError('voice.elevenlabs_error', `ElevenLabs speech failed (${res.status}): ${redactSecrets(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
