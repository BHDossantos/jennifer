import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * Jennifer's server. EAS builds set EXPO_PUBLIC_JENNIFER_API_URL (eas.json);
 * the fallback keeps a build that missed it working instead of failing every call.
 */
export const API_BASE = (process.env.EXPO_PUBLIC_JENNIFER_API_URL || 'https://jennifer-29d4.onrender.com').replace(/\/$/, '');
const KEY = 'jennifer.session.token';

export const saveToken = (v: string) => SecureStore.setItemAsync(KEY, v);
export const clearToken = () => SecureStore.deleteItemAsync(KEY);
export const hasToken = async () => !!(await SecureStore.getItemAsync(KEY));

/** Called when the server says the session is gone (revoked, expired): the app goes back to the connect screen. */
let onSignedOut: (() => void) | undefined;
export function setSignedOutHandler(fn: () => void) {
  onSignedOut = fn;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  const token = auth ? await SecureStore.getItemAsync(KEY) : null;
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...((init.headers as Record<string, string>) || {}) } });
  } catch {
    throw new ApiError(0, 'Jennifer is unreachable. Check your connection and try again.');
  }
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (res.status === 401 && auth) {
    await clearToken();
    onSignedOut?.();
    throw new ApiError(401, 'Please connect the app again.', 'signed_out');
  }
  if (!res.ok) throw new ApiError(res.status, body?.message || body?.error || 'HTTP ' + res.status, body?.error);
  return body as T;
}
const post = (path: string, body: unknown = {}) => request<any>(path, { method: 'POST', body: JSON.stringify(body) });

/** Message for an error, never an object. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong');

export const JenniferAPI = {
  health: () => request<{ ok: boolean }>('/health', {}, false),
  /** Trade the one-time code from Jennifer on the web (Settings → Connect the iPhone app) for this phone's own session. */
  pair: async (code: string) => {
    const r = await request<{ token: string }>('/v1/auth/pair/finish', { method: 'POST', body: JSON.stringify({ code, platform: Platform.OS, label: 'Jennifer iPhone app', osVersion: String(Platform.Version) }) }, false);
    await saveToken(r.token);
  },
  today: () => request<any>('/v1/today'),
  debrief: () => request<any>('/v1/debrief'),
  actions: (state?: string) => request<any[]>('/v1/actions' + (state ? '?state=' + encodeURIComponent(state) : '')),
  action: (id: string) => request<any>('/v1/actions/' + id),
  approve: (id: string, revision: number, payloadHash: string) => post('/v1/actions/' + id + '/approve', { revision, payloadHash }),
  cancel: (id: string, note = 'Canceled from the iPhone app') => post('/v1/actions/' + id + '/cancel', { note }),
  conversations: () => request<any[]>('/v1/conversations'),
  conversation: (id: string) => request<any>('/v1/conversations/' + id),
  missions: () => request<any>('/v1/missions'),
  runMission: (id: string) => post('/v1/missions/' + id + '/run', { mode: 'work', reason: 'Requested from the iPhone app' }),
  voice: () => request<any>('/v1/voice'),
  notificationPrefs: () => request<any>('/v1/notifications/prefs'),
  memoryPending: () => request<any[]>('/v1/memory/pending'),
  activateMemory: (id: string) => post('/v1/memory/' + id + '/activate'),
  chat: (message: string, sessionId?: string) => post('/v1/chat', { message, sessionId }),
  logout: () => post('/v1/auth/logout'),
};
