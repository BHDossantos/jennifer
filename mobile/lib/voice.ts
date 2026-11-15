import { createAudioPlayer, requestRecordingPermissionsAsync, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as FS from 'expo-file-system/legacy';
import { API_BASE, ApiError, authHeader, handleSignedOut } from './api';

/** Recording: m4a (AAC), mono, with level metering so a turn can end itself when Bruno stops talking. */
export const RECORDING = {
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 96000,
  isMeteringEnabled: true,
  android: { outputFormat: 'mpeg4' as const, audioEncoder: 'aac' as const },
  ios: { outputFormat: 'aac ' as const, audioQuality: 96, linearPCMBitDepth: 16, linearPCMIsBigEndian: false, linearPCMIsFloat: false },
  web: { mimeType: 'audio/webm', bitsPerSecond: 96000 },
};

export async function micAllowed(): Promise<boolean> {
  const p = await requestRecordingPermissionsAsync();
  return p.granted;
}

/** Microphone on. iOS routes audio to the quiet earpiece while recording is allowed, so this is only on while listening. */
export const listenMode = () => setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, shouldRouteThroughEarpiece: false });
/** Loudspeaker, even with the silent switch on. */
export const speakMode = () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, shouldRouteThroughEarpiece: false });

type Playback = { player: AudioPlayer | null; stopped: boolean; finish?: () => void };
let current: Playback | null = null;
let playbackId = 0;

function dispose(playback: Playback) {
  playback.stopped = true;
  playback.finish?.();
  // A pause failure must not prevent native-player disposal.
  try { playback.player?.pause(); } catch {}
  try { playback.player?.remove(); } catch {}
  playback.player = null;
  if (current === playback) current = null;
}

export function stopSpeaking() {
  if (current) dispose(current);
}

/** Play a reply, releasing native resources and cached audio on every exit. */
export async function playBase64(audioBase64: string): Promise<void> {
  stopSpeaking();
  const playback: Playback = { player: null, stopped: false };
  current = playback;
  const uri = `${FS.cacheDirectory}jennifer-${Date.now()}-${++playbackId}.mp3`;
  try {
    await speakMode();
    if (playback.stopped) return;
    await FS.writeAsStringAsync(uri, audioBase64, { encoding: FS.EncodingType.Base64 });
    if (playback.stopped) return;
    const player = createAudioPlayer({ uri });
    playback.player = player;
    await new Promise<void>((resolve, reject) => {
      let sub: { remove: () => void } | undefined;
      let guard: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        try { sub?.remove(); } catch {}
        clearTimeout(guard);
        resolve();
      };
      playback.finish = done;
      try {
        sub = player.addListener('playbackStatusUpdate', (st) => {
          if (st.didJustFinish) done();
        });
        guard = setTimeout(done, 180_000);
        player.play();
      } catch (error) {
        try { sub?.remove(); } catch {}
        clearTimeout(guard);
        finished = true;
        reject(error);
      }
    });
  } finally {
    dispose(playback);
    await FS.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
}

export type VoiceTurn = { sessionId?: string; transcript: string; reply: string; audioBase64: string };

/** One spoken turn: the recording goes to Jennifer, who transcribes, thinks (same tools and rules as chat) and answers in her voice. */
export async function sendTurn(fileUri: string, sessionId?: string, language = 'en'): Promise<VoiceTurn> {
  const q = `?language=${language}${sessionId ? '&sessionId=' + encodeURIComponent(sessionId) : ''}`;
  let r: FS.FileSystemUploadResult;
  try {
    r = await FS.uploadAsync(`${API_BASE}/v1/voice/turn${q}`, fileUri, {
      httpMethod: 'POST',
      uploadType: FS.FileSystemUploadType.BINARY_CONTENT,
      headers: { 'content-type': 'audio/m4a', ...(await authHeader()) },
    });
  } catch {
    throw new ApiError(0, 'Jennifer is unreachable. Check your connection and try again.');
  } finally {
    await FS.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
  }
  let body: any = {};
  try {
    body = JSON.parse(r.body || '{}');
  } catch {}
  if (r.status === 401) {
    await handleSignedOut();
    throw new ApiError(401, 'Please connect the app again.', 'signed_out');
  }
  if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, body?.message || body?.error || 'HTTP ' + r.status, body?.error);
  return body as VoiceTurn;
}
