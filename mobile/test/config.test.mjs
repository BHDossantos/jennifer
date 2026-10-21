import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateMobileConfig } from '../scripts/check-mobile-config.mjs';
const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8'));

test('checked-in iOS and Android configuration is complete', () => {
  assert.deepEqual(validateMobileConfig(app, eas), []);
});
test('missing native identifiers are rejected', () => {
  const invalid = structuredClone(app); delete invalid.expo.android.package; delete invalid.expo.ios.bundleIdentifier;
  assert.equal(validateMobileConfig(invalid, eas).length, 2);
});
test('missing EAS project linkage is rejected', () => {
  const invalid = structuredClone(app); delete invalid.expo.extra.eas.projectId;
  assert.match(validateMobileConfig(invalid, eas).join(), /project ID/);
});
for (const url of ['', 'http://example.test', 'https://localhost', 'https://[::1]', 'https://user:password@example.test']) {
  test(`invalid production API URL is rejected: ${url || '(missing)'}`, () => {
    const invalid = structuredClone(eas); invalid.build.production.env.EXPO_PUBLIC_JENNIFER_API_URL = url;
    assert.match(validateMobileConfig(app, invalid).join(), /production/);
  });
}
test('missing profile is rejected', () => {
  const invalid = structuredClone(eas); delete invalid.build.preview;
  assert.match(validateMobileConfig(app, invalid).join(), /preview/);
});
