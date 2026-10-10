import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { API_BASE, getToken } from '@/lib/api';
import { C } from '@/components/ui';

/**
 * All of Jennifer — companies and their department agents, handoffs, debrief,
 * Claude tasks, Bruno AI, marketing, settings — signed in with this phone's own session.
 */
export default function Everything() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState('');
  const web = useRef<WebView>(null);
  useEffect(() => {
    getToken().then(setToken);
  }, []);
  if (token === undefined) return <View style={s.center}><ActivityIndicator color={C.text} /></View>;
  // The web app reads its session from localStorage before its own script runs.
  const inject = `try{localStorage.setItem('jennifer_session',${JSON.stringify(token ?? '')});}catch(e){};true;`;
  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {failed ? (
        <View style={s.center}>
          <Text style={s.text}>Couldn't open Jennifer: {failed}</Text>
          <Pressable style={s.btn} onPress={() => { setFailed(''); web.current?.reload(); }}><Text style={s.btnText}>Try again</Text></Pressable>
        </View>
      ) : (
        <WebView
          ref={web}
          source={{ uri: API_BASE + '/' }}
          injectedJavaScriptBeforeContentLoaded={inject}
          originWhitelist={['https://*']}
          sharedCookiesEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          mediaCapturePermissionGrantType="grant"
          allowsBackForwardNavigationGestures
          pullToRefreshEnabled
          startInLoadingState
          renderLoading={() => <View style={s.center}><ActivityIndicator color={C.text} /></View>}
          onError={(e) => setFailed(e.nativeEvent.description || 'network error')}
          onShouldStartLoadWithRequest={(req) => {
            // Jennifer's own pages stay inside; anything else (Claude, Gmail links…) opens outside.
            if (req.url.startsWith(API_BASE) || req.url === 'about:blank') return true;
            Linking.openURL(req.url).catch(() => {});
            return false;
          }}
          style={{ backgroundColor: C.bg }}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  text: { color: C.text, fontSize: 15, textAlign: 'center' },
  btn: { backgroundColor: C.accent, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 12 },
  btnText: { color: '#10151d', fontWeight: '800' },
});
