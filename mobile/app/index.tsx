import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Redirect } from 'expo-router';
import { hasToken } from '@/lib/api';
import { C } from '@/components/ui';

/** Signed in → Jennifer; first launch → connect with a code. */
export default function Index() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    hasToken().then(setSignedIn).catch(() => setSignedIn(false));
  }, []);
  if (signedIn === null)
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={C.text} />
      </View>
    );
  return <Redirect href={signedIn ? '/(tabs)' : '/connect'} />;
}
