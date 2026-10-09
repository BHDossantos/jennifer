import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { JenniferAPI, errorText } from '@/lib/api';
import { Button, C, Card } from '@/components/ui';

/** First launch: pair this phone with Jennifer using the one-time code from the web app. */
export default function Connect() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function connect() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await JenniferAPI.pair(code.trim());
      router.replace('/(tabs)');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.wrap}>
        <Text style={s.title}>Jennifer</Text>
        <Text style={s.sub}>Connect this iPhone to your Jennifer.</Text>
        <Card>
          <Text style={s.step}>1. On your computer or in Safari, open Jennifer → Settings → “Connect the iPhone app” → Make a code.</Text>
          <Text style={s.step}>2. Type the code here.</Text>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="ABCD-EFGH"
            placeholderTextColor={C.muted}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={12}
            style={s.input}
            onSubmitEditing={connect}
          />
          {busy ? <ActivityIndicator color={C.text} /> : <Button title="Connect" onPress={connect} disabled={code.replace(/[^A-Za-z0-9]/g, '').length < 8} />}
          {!!error && <Text style={s.error}>{error}</Text>}
        </Card>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  wrap: { flex: 1, justifyContent: 'center', padding: 20, gap: 14 },
  title: { fontSize: 34, fontWeight: '800', color: C.text },
  sub: { color: C.muted, fontSize: 16 },
  step: { color: C.text, fontSize: 15, lineHeight: 21 },
  input: { backgroundColor: '#0b0f16', borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 14, color: C.text, fontSize: 24, letterSpacing: 4, textAlign: 'center' },
  error: { color: '#f0a070', fontSize: 14 },
});
