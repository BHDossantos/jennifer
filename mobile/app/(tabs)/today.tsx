import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { JenniferAPI, errorText } from '@/lib/api';
import { C, Card, Label } from '@/components/ui';

const str = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : String(v));

export default function Today() {
  const [data, setData] = useState<any>();
  const [debrief, setDebrief] = useState<any>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [t, d] = await Promise.all([JenniferAPI.today(), JenniferAPI.debrief().catch(() => undefined)]);
      setData(t);
      setDebrief(d);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const brief = data?.brief ?? {};
  const calendar: any[] = Array.isArray(brief.today) ? brief.today : [];
  const waiting: any[] = Array.isArray(data?.awaitingDecision) ? data.awaitingDecision : [];
  const failures: any[] = Array.isArray(brief.failures) ? brief.failures : [];
  const warnings: string[] = Array.isArray(data?.configWarnings) ? data.configWarnings : [];
  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={C.text} />} contentContainerStyle={s.body}>
        <Text style={s.h1}>Today</Text>
        {!!error && <Card><Text style={s.warn}>{error}</Text></Card>}
        {warnings.length > 0 && (
          <Card>
            <Label>SETTINGS TO FIX</Label>
            {warnings.map((w, i) => <Text key={i} style={s.warn}>{str(w)}</Text>)}
          </Card>
        )}
        <Card>
          <Label>CALENDAR</Label>
          {calendar.length ? calendar.map((e, i) => <Text key={i} style={s.text}>{str(e.time)} · {str(e.title)}</Text>) : <Text style={s.muted}>Nothing else on your calendar today.</Text>}
        </Card>
        <Card>
          <Label>WAITING FOR YOU</Label>
          {waiting.length ? waiting.slice(0, 8).map((a, i) => <Text key={a.id ?? i} style={s.text}>• {str(a.subject || a.type)}{a.recipients?.length ? ' → ' + a.recipients.map(str).join(', ') : ''}</Text>) : <Text style={s.muted}>Nothing needs your decision.</Text>}
        </Card>
        {debrief && (
          <Card>
            <Label>WHAT I DID TODAY</Label>
            <Text style={s.text}>
              {(debrief.sent?.length ?? 0) + ' sent · ' + Object.values(debrief.received ?? {}).reduce((a: number, b: any) => a + Number(b || 0), 0) + ' received · ' + (debrief.handled?.length ?? 0) + ' conversation(s) handled'}
            </Text>
          </Card>
        )}
        {failures.length > 0 && (
          <Card>
            <Label>PROBLEMS</Label>
            {failures.map((f, i) => <Text key={f.id ?? i} style={s.warn}>{str(f.summary)}</Text>)}
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  body: { padding: 16, gap: 12 },
  h1: { fontSize: 30, fontWeight: '800', color: C.text },
  text: { fontSize: 15, lineHeight: 22, color: C.text },
  muted: { fontSize: 15, color: C.muted },
  warn: { fontSize: 14, color: '#f0a070' },
});
