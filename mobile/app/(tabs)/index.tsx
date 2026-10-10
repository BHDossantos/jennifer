import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { JenniferAPI, errorText } from '@/lib/api';
import { RECORDING, listenMode, micAllowed, playBase64, sendTurn, stopSpeaking } from '@/lib/voice';
import { C } from '@/components/ui';

type Msg = { role: 'you' | 'jennifer'; text: string };
type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

/** Level (dBFS) that counts as talking, and how long a pause ends a turn. */
const SPEECH_DB = -38;
const PAUSE_MS = 1300;
const NO_SPEECH_MS = 9000;
const MAX_TURN_MS = 60_000;

export default function Home() {
  const params = useLocalSearchParams<{ talk?: string }>();
  const [online, setOnline] = useState<boolean | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [readAloud, setReadAloud] = useState(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [msgs, setMsgs] = useState<Msg[]>([{ role: 'jennifer', text: "Hi Bruno. Tap the circle and talk to me, or type below." }]);
  const sessionId = useRef<string | undefined>(undefined);
  const scroll = useRef<ScrollView>(null);

  const recorder = useAudioRecorder(RECORDING as never);
  const rec = useAudioRecorderState(recorder, 150);
  const talking = useRef(false); // conversation mode on
  const turn = useRef({ startedAt: 0, heardAt: 0, lastLoudAt: 0, stopping: false });

  const add = (m: Msg) => setMsgs((x) => [...x, m]);
  useEffect(() => {
    JenniferAPI.health().then(() => setOnline(true)).catch(() => setOnline(false));
  }, []);
  useEffect(() => {
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
  }, [msgs.length, phase]);

  const listen = useCallback(async () => {
    if (!talking.current) return;
    try {
      await listenMode();
      await recorder.prepareToRecordAsync();
      recorder.record();
      const now = Date.now();
      turn.current = { startedAt: now, heardAt: 0, lastLoudAt: now, stopping: false };
      setPhase('listening');
    } catch (e) {
      talking.current = false;
      setPhase('idle');
      add({ role: 'jennifer', text: 'I could not use the microphone. ' + errorText(e) });
    }
  }, [recorder]);

  const endTurn = useCallback(
    async (heardSomething: boolean) => {
      if (turn.current.stopping) return;
      turn.current.stopping = true;
      try {
        await recorder.stop();
      } catch {}
      const uri = recorder.uri;
      if (!talking.current) return setPhase('idle');
      if (!heardSomething || !uri) {
        // Nobody spoke: end the conversation quietly.
        talking.current = false;
        return setPhase('idle');
      }
      setPhase('thinking');
      try {
        const r = await sendTurn(uri, sessionId.current);
        sessionId.current = r.sessionId ?? sessionId.current;
        add({ role: 'you', text: r.transcript });
        add({ role: 'jennifer', text: r.reply });
        if (!talking.current) return setPhase('idle');
        setPhase('speaking');
        await playBase64(r.audioBase64);
      } catch (e) {
        const msg = errorText(e);
        add({ role: 'jennifer', text: /didn.t catch/i.test(msg) ? msg : 'Voice problem: ' + msg });
        if (!/didn.t catch/i.test(msg)) talking.current = false;
      }
      if (talking.current) listen();
      else setPhase('idle');
    },
    [recorder, listen],
  );

  // End of turn detection: Bruno spoke, then paused.
  useEffect(() => {
    if (phase !== 'listening' || !rec.isRecording || turn.current.stopping) return;
    const now = Date.now();
    const level = rec.metering ?? -160;
    if (level > SPEECH_DB) {
      if (!turn.current.heardAt) turn.current.heardAt = now;
      turn.current.lastLoudAt = now;
    }
    const t = turn.current;
    if (t.heardAt && now - t.lastLoudAt > PAUSE_MS) endTurn(true);
    else if (!t.heardAt && now - t.startedAt > NO_SPEECH_MS) endTurn(false);
    else if (now - t.startedAt > MAX_TURN_MS) endTurn(!!t.heardAt);
  }, [rec, phase, endTurn]);

  const toggleTalk = useCallback(async () => {
    if (talking.current || phase !== 'idle') {
      talking.current = false;
      stopSpeaking();
      if (phase === 'listening') {
        turn.current.stopping = true;
        try {
          await recorder.stop();
        } catch {}
      }
      setPhase('idle');
      return;
    }
    if (!(await micAllowed())) {
      Alert.alert('Microphone', 'Allow microphone access for Jennifer in iPhone Settings → Jennifer.');
      return;
    }
    talking.current = true;
    listen();
  }, [phase, recorder, listen]);

  // Siri / Action button / jennifer://talk opens straight into a conversation.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (params.talk === '1' && !autoStarted.current) {
      autoStarted.current = true;
      setTimeout(toggleTalk, 400);
    }
  }, [params.talk, toggleTalk]);

  async function send() {
    const q = input.trim();
    if (!q || busy) return;
    setInput('');
    add({ role: 'you', text: q });
    setBusy(true);
    try {
      const r = await JenniferAPI.chat(q, sessionId.current);
      if (r?.sessionId) sessionId.current = r.sessionId;
      const reply = String(r?.reply || '(no reply)');
      add({ role: 'jennifer', text: reply });
      if (readAloud) {
        JenniferAPI.speak(reply)
          .then((a) => playBase64(a.audioBase64))
          .catch((e) => add({ role: 'jennifer', text: 'I could not speak that reply: ' + errorText(e) }));
      }
    } catch (e) {
      add({ role: 'jennifer', text: 'I could not reach the Jennifer service. ' + errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const label = { idle: 'Tap to talk', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking… tap to stop' }[phase];
  const level = phase === 'listening' ? Math.max(0, Math.min(1, ((rec.metering ?? -60) + 60) / 50)) : 0;

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <View>
          <Text style={s.title}>Jennifer</Text>
          <Text style={s.sub}>Executive AI Assistant</Text>
        </View>
        <Text style={[s.status, online === false && { color: '#f0a070' }]}>{online ? 'ONLINE' : online === false ? 'OFFLINE' : '…'}</Text>
      </View>
      <ScrollView ref={scroll} contentContainerStyle={s.body}>
        {msgs.map((m, i) => (
          <View key={i} style={[s.msg, m.role === 'you' ? s.mine : s.hers]}>
            <Text style={s.kicker}>{m.role === 'you' ? 'YOU' : 'JENNIFER'}</Text>
            <Text style={s.msgText}>{m.text}</Text>
          </View>
        ))}
        {(busy || phase === 'thinking') && <ActivityIndicator color={C.text} />}
      </ScrollView>
      <View style={s.voiceRow}>
        <Pressable onPress={toggleTalk} accessibilityLabel={label} style={[s.orb, phase !== 'idle' && s.orbOn, { transform: [{ scale: 1 + level * 0.18 }] }]}>
          <Text style={s.orbText}>{phase === 'idle' ? '🎙' : phase === 'listening' ? '●' : phase === 'thinking' ? '…' : '■'}</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.voiceLabel}>{label}</Text>
          <View style={s.aloud}>
            <Switch value={readAloud} onValueChange={setReadAloud} />
            <Text style={s.muted}>Read typed replies aloud</Text>
          </View>
        </View>
      </View>
      <View style={s.composer}>
        <TextInput value={input} onChangeText={setInput} onSubmitEditing={send} placeholder="Or type to Jennifer…" placeholderTextColor="#727b89" style={s.input} multiline blurOnSubmit />
        <Pressable onPress={send} style={s.send}>
          <Text style={s.sendText}>↑</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { padding: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#1b2029' },
  title: { fontSize: 30, fontWeight: '700', color: '#f7f8fa' },
  sub: { color: '#8e97a6' },
  status: { fontSize: 11, color: '#a9c5e8', fontWeight: '800' },
  body: { padding: 16, gap: 12 },
  kicker: { fontSize: 10, fontWeight: '800', letterSpacing: 1.3, color: '#8ba7cc', marginBottom: 6 },
  msg: { maxWidth: '88%', padding: 14, borderRadius: 18 },
  mine: { alignSelf: 'flex-end', backgroundColor: '#263b5a' },
  hers: { alignSelf: 'flex-start', backgroundColor: '#151a22', borderWidth: 1, borderColor: '#232b36' },
  msgText: { fontSize: 16, lineHeight: 22, color: '#f1f3f6' },
  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#1b2029' },
  orb: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#1d2a3d', borderWidth: 2, borderColor: '#3a5a85', alignItems: 'center', justifyContent: 'center' },
  orbOn: { backgroundColor: '#2f6f73', borderColor: '#5fd0c4' },
  orbText: { fontSize: 28, color: '#fff' },
  voiceLabel: { color: C.text, fontSize: 17, fontWeight: '700' },
  aloud: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  muted: { color: C.muted, fontSize: 13 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', padding: 12, gap: 8 },
  input: { flex: 1, minHeight: 48, maxHeight: 130, backgroundColor: '#111722', borderRadius: 18, paddingHorizontal: 16, paddingVertical: 13, color: '#fff', fontSize: 16 },
  send: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#e8edf5', alignItems: 'center', justifyContent: 'center' },
  sendText: { fontSize: 25, color: '#10151d', fontWeight: '700' },
});
