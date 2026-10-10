import { Tabs } from 'expo-router';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: '#0d1118', borderTopColor: '#202733' },
        tabBarActiveTintColor: '#d9e7fa',
        tabBarInactiveTintColor: '#6f7a8a',
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Jennifer' }} />
      <Tabs.Screen name="everything" options={{ title: 'Everything' }} />
      <Tabs.Screen name="today" options={{ title: 'Today' }} />
      <Tabs.Screen name="actions" options={{ title: 'Approvals' }} />
      <Tabs.Screen name="conversations" options={{ title: 'Inbox' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      <Tabs.Screen name="missions" options={{ href: null }} />
    </Tabs>
  );
}
