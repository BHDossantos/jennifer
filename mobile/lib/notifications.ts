import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { JenniferAPI } from './api';

Notifications.setNotificationHandler({handleNotification:async()=>({shouldShowBanner:true,shouldShowList:true,shouldPlaySound:true,shouldSetBadge:true})});
export async function registerForNotifications() {
  // Android 13 requires a channel before its notification permission prompt.
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('jennifer', {
    name: 'Jennifer', importance: Notifications.AndroidImportance.DEFAULT,
  });
  const current = await Notifications.getPermissionsAsync();
  const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return false;
  const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) throw new Error('Notification project is not configured');
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  await JenniferAPI.registerPush(data);
  return true;
}
