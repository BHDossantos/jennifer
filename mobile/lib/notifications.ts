import * as Notifications from 'expo-notifications';
Notifications.setNotificationHandler({handleNotification:async()=>({shouldShowBanner:true,shouldShowList:true,shouldPlaySound:true,shouldSetBadge:true})});
export async function requestNotificationPermission(){const current=await Notifications.getPermissionsAsync();if(current.granted)return true;return (await Notifications.requestPermissionsAsync()).granted;}
