import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real API module, replacing only native storage/platform and network.
// No device, credentials or live backend is contacted by these unit tests.
const code = ts.transpileModule(readFileSync(new URL('../lib/api.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function fixture({ token, status = 200, body = {}, offline = false, platform = 'ios' } = {}) {
  const storage = new Map(token ? [['jennifer.session.token', token]] : []);
  const calls = [];
  const exports = {};
  vm.runInNewContext(code, {
    exports, Error, process: { env: { EXPO_PUBLIC_JENNIFER_API_URL: 'https://api.example.test/' } },
    require(name) {
      if (name === 'expo-secure-store') return {
        getItemAsync: async (key) => storage.get(key) ?? null,
        setItemAsync: async (key, value) => { storage.set(key, value); },
        deleteItemAsync: async (key) => { storage.delete(key); },
      };
      if (name === 'react-native') return { Platform: { OS: platform, Version: 35 } };
      throw new Error(`Unexpected module: ${name}`);
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (offline) throw new Error('offline');
      return { status, ok: status >= 200 && status < 300, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
    },
  }, { filename: 'api.js' });
  return { api: exports, calls, storage };
}

test('authenticated requests use SecureStore bearer tokens and normalize the API URL', async () => {
  const { api, calls } = fixture({ token: 'test-token' });
  await api.JenniferAPI.today();
  assert.equal(calls[0].url, 'https://api.example.test/v1/today');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-token');
});
test('public health checks do not transmit saved tokens', async () => {
  const { api, calls } = fixture({ token: 'test-token' });
  await api.JenniferAPI.health();
  assert.equal(calls[0].init.headers.authorization, undefined);
});
for (const platform of ['ios', 'android']) {
  test(`pairing saves the returned session and records ${platform}`, async () => {
    const { api, calls, storage } = fixture({ token: 'old-token', body: { token: 'new-token' }, platform });
    await api.JenniferAPI.pair('123456');
    assert.equal(calls[0].init.headers.authorization, undefined);
    assert.equal(JSON.parse(calls[0].init.body).platform, platform);
    assert.equal(storage.get('jennifer.session.token'), 'new-token');
  });
}
test('revoked sessions clear storage, call sign-out handler and give a useful error', async () => {
  const { api, storage } = fixture({ token: 'revoked-token', status: 401 });
  let signedOut = 0; api.setSignedOutHandler(() => signedOut++);
  await assert.rejects(api.JenniferAPI.today(), (error) => error.status === 401 && error.code === 'signed_out');
  assert.equal(storage.size, 0); assert.equal(signedOut, 1);
});
test('failed public pairing does not sign out the current session', async () => {
  const { api, storage } = fixture({ token: 'existing-token', status: 401, body: { error: 'invalid_code' } });
  await assert.rejects(api.JenniferAPI.pair('bad-code'), (error) => error.status === 401 && error.code === 'invalid_code');
  assert.equal(storage.get('jennifer.session.token'), 'existing-token');
});
test('network failures provide an offline message rather than a raw fetch error', async () => {
  const { api } = fixture({ offline: true });
  await assert.rejects(api.JenniferAPI.today(), (error) => error.status === 0 && /unreachable/.test(error.message));
});
test('non-JSON server failures remain readable', async () => {
  const { api } = fixture({ status: 502, body: 'Upstream unavailable' });
  await assert.rejects(api.JenniferAPI.today(), (error) => error.status === 502 && error.message === 'Upstream unavailable');
});
test('empty successful responses do not crash JSON parsing', async () => {
  const { api } = fixture({ status: 204, body: '' });
  assert.deepEqual(Object.keys(await api.JenniferAPI.logout()), []);
});
test('action approval includes revision and payload hash', async () => {
  const { api, calls } = fixture({ token: 'test-token' });
  await api.JenniferAPI.approve('action-1', 7, 'test-hash');
  assert.equal(calls[0].url, 'https://api.example.test/v1/actions/action-1/approve');
  assert.deepEqual(JSON.parse(calls[0].init.body), { revision: 7, payloadHash: 'test-hash' });
});
test('action filters are URI encoded', async () => {
  const { api, calls } = fixture(); await api.JenniferAPI.actions('needs review');
  assert.match(calls[0].url, /state=needs%20review$/);
});
test('unknown error objects are never returned directly to Text', () => {
  const { api } = fixture();
  assert.equal(api.errorText({ message: 'object' }), 'Something went wrong');
  assert.equal(api.errorText(new Error('message')), 'message');
});
