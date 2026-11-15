import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync(new URL('../lib/voice.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture({playError=false,uploadError=false,mode}={}) {
 const exports={},players=[],deleted=[],timers=new Set();
 vm.runInNewContext(code,{exports,Error,Date,setTimeout(fn){timers.add(fn);return fn;},clearTimeout(fn){timers.delete(fn);},require(name){
  if(name==='expo-audio')return {setAudioModeAsync:mode||(async()=>{}),createAudioPlayer(){
   const p={removed:0,unsubscribed:0,pause(){},remove(){this.removed++;},play(){if(playError)throw new Error('play failed');},addListener(event,listener){this.listener=listener;return {remove:()=>p.unsubscribed++};}};
   players.push(p);return p;
  }};
  if(name==='expo-file-system/legacy')return {cacheDirectory:'/cache/',EncodingType:{Base64:'base64'},FileSystemUploadType:{BINARY_CONTENT:0},writeAsStringAsync:async()=>{},deleteAsync:async uri=>{deleted.push(uri);},uploadAsync:async()=>{if(uploadError)throw new Error('offline');return {status:200,body:'{}'};}};
  if(name==='./api')return {API_BASE:'https://example.test',authHeader:async()=>({}),ApiError:class extends Error{}};
  throw new Error(name);
 }});
 return {api:exports,players,deleted,timers};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('stop settles playback and releases listener, timer, player and cached audio',async()=>{
 const f=fixture(),p=f.api.playBase64('audio');await flush();assert.equal(f.timers.size,1);f.api.stopSpeaking();await p;
 assert.equal(f.players[0].removed,1);assert.equal(f.players[0].unsubscribed,1);assert.equal(f.timers.size,0);assert.equal(f.deleted.length,1);
});
test('normal completion releases playback resources',async()=>{
 const f=fixture(),p=f.api.playBase64('audio');await flush();f.players[0].listener({didJustFinish:true});await p;
 assert.equal(f.players[0].removed,1);assert.equal(f.timers.size,0);assert.equal(f.deleted.length,1);
});
test('play failure still clears native resources and cached reply',async()=>{
 const f=fixture({playError:true});await assert.rejects(f.api.playBase64('audio'),/play failed/);
 assert.equal(f.players[0].removed,1);assert.equal(f.timers.size,0);assert.equal(f.deleted.length,1);
});
test('stop during preparation prevents later playback',async()=>{
 let ready;const f=fixture({mode:()=>new Promise(resolve=>{ready=resolve;})}),p=f.api.playBase64('audio');f.api.stopSpeaking();ready();await p;
 assert.equal(f.players.length,0);assert.equal(f.deleted.length,1);
});
test('replaced reply cannot dispose the new reply',async()=>{
 const f=fixture(),first=f.api.playBase64('first');await flush();const second=f.api.playBase64('second');await first;await flush();
 assert.equal(f.players[0].removed,1);assert.equal(f.players[1].removed,0);f.api.stopSpeaking();await second;
 assert.equal(new Set(f.deleted).size,2);assert.equal(f.timers.size,0);
});
test('failed upload deletes the local recording',async()=>{
 const f=fixture({uploadError:true});await assert.rejects(f.api.sendTurn('/cache/recording.m4a'));assert.deepEqual(f.deleted,['/cache/recording.m4a']);
});
test('missing completion event releases playback at the guard deadline',async()=>{
 const f=fixture(),p=f.api.playBase64('audio');await flush();[...f.timers][0]();await p;
 assert.equal(f.players[0].removed,1);assert.equal(f.timers.size,0);assert.equal(f.deleted.length,1);
});
