import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const code = ts.transpileModule(readFileSync(new URL('../lib/notifications.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
function fixture({ granted = true, projectId = 'project', fail = false, platform = 'android' } = {}) {
  const events = [], exports = {};
  vm.runInNewContext(code, { exports, Error, require(name) {
    if (name === 'expo-notifications') return {
      setNotificationHandler() {}, AndroidImportance: { DEFAULT: 3 },
      setNotificationChannelAsync: async () => events.push('channel'),
      getPermissionsAsync: async () => { events.push('permission'); return { granted }; },
      requestPermissionsAsync: async () => ({ granted }),
      getExpoPushTokenAsync: async opts => { events.push(opts.projectId); return { data: 'ExpoPushToken[test]' }; },
    };
    if (name === 'expo-constants') return { easConfig: { projectId } };
    if (name === 'react-native') return { Platform: { OS: platform } };
    if (name === './api') return { JenniferAPI: { registerPush: async token => {
      if (fail) throw new Error('offline'); events.push(token);
    } } };
    throw new Error(name);
  } });
  return { register: exports.registerForNotifications, events };
}
test('Android channel precedes permissions and registration', async () => {
  const { register, events } = fixture();
  assert.equal(await register(), true);
  assert.deepEqual(events, ['channel', 'permission', 'project', 'ExpoPushToken[test]']);
});
test('denied permission never obtains or registers a token', async () => {
  const { register, events } = fixture({ granted: false });
  assert.equal(await register(), false); assert.deepEqual(events, ['channel', 'permission']);
});
test('iOS registers without an Android channel', async () => {
  const { register, events } = fixture({ platform: 'ios' });
  assert.equal(await register(), true); assert.equal(events.includes('channel'), false);
});
test('registration failure is not reported as success', async () => {
  await assert.rejects(fixture({ fail: true }).register(), /offline/);
});
test('missing project linkage fails before token acquisition', async () => {
  await assert.rejects(fixture({ projectId: null }).register(), /not configured/);
});
