import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { setSignedOutHandler } from '@/lib/api';
import { C } from '@/components/ui';

/** Any crash shows this instead of a blank screen (TestFlight builds have no red error box). */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={s.err}>
      <Text style={s.errTitle}>Jennifer hit a problem</Text>
      <Text style={s.errText}>{error?.message || 'Unknown error'}</Text>
      <Pressable onPress={retry} style={s.btn}>
        <Text style={s.btnText}>Try again</Text>
      </Pressable>
    </View>
  );
}

export default function Layout() {
  const router = useRouter();
  useEffect(() => {
    setSignedOutHandler(() => router.replace('/connect'));
  }, [router]);
  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }} />
    </>
  );
}

const s = StyleSheet.create({
  err: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14 },
  errTitle: { color: C.text, fontSize: 22, fontWeight: '800' },
  errText: { color: C.muted, fontSize: 15, textAlign: 'center' },
  btn: { backgroundColor: C.accent, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 12 },
  btnText: { color: '#10151d', fontWeight: '800' },
});
