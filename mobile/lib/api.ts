import * as SecureStore from 'expo-secure-store';
const base=(process.env.EXPO_PUBLIC_JENNIFER_API_URL??'').replace(/\/$/,'');
const KEY='jennifer.session.token';
export const saveToken=(v:string)=>SecureStore.setItemAsync(KEY,v);
export const clearToken=()=>SecureStore.deleteItemAsync(KEY);
async function request<T>(path:string,init:RequestInit={}):Promise<T>{if(!base)throw new Error('Set EXPO_PUBLIC_JENNIFER_API_URL');const token=await SecureStore.getItemAsync(KEY);const res=await fetch(base+path,{...init,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(init.headers||{})}});const text=await res.text();if(!res.ok)throw new Error(text||('HTTP '+res.status));return text?JSON.parse(text):{} as T;}
export const JenniferAPI={health:()=>request<{ok:boolean}>('/health'),today:()=>request<any>('/v1/today'),actions:()=>request<any>('/v1/actions'),conversations:()=>request<any>('/v1/conversations'),missions:()=>request<any>('/v1/missions'),chat:(message:string)=>request<any>('/v1/chat',{method:'POST',body:JSON.stringify({message})})};
