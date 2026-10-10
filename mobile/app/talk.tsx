import { Redirect } from 'expo-router';

/** jennifer://talk — for a Siri Shortcut ("Hey Siri, Jennifer") or the Action button: opens straight into a voice conversation. */
export default function Talk() {
  return <Redirect href={{ pathname: '/(tabs)', params: { talk: '1' } }} />;
}
