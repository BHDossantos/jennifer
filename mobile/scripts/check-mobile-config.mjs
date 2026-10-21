import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function validateMobileConfig(app, eas) {
  const errors = [];
  const expo = app?.expo ?? {};
  const identifier = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
  if (!identifier.test(expo.ios?.bundleIdentifier ?? '')) errors.push('A valid iOS bundle identifier is required.');
  if (!identifier.test(expo.android?.package ?? '')) errors.push('A valid Android package is required.');
  if (!/^\d+\.\d+\.\d+$/.test(expo.version ?? '')) errors.push('A semantic app version is required.');
  if (!expo.scheme) errors.push('A deep-link scheme is required.');
  if (!/^[\da-f]{8}-([\da-f]{4}-){3}[\da-f]{12}$/i.test(expo.extra?.eas?.projectId ?? '')) errors.push('The existing EAS project ID must be configured.');
  for (const name of ['development', 'preview', 'production']) {
    const profile = eas?.build?.[name];
    if (!profile) { errors.push(`Missing ${name} build profile.`); continue; }
    try {
      const url = new URL(profile.env?.EXPO_PUBLIC_JENNIFER_API_URL);
      if (url.protocol !== 'https:' || url.username || url.password || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error();
    } catch { errors.push(`${name} must configure a public HTTPS Jennifer API URL without credentials.`); }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  const eas = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8'));
  const errors = validateMobileConfig(app, eas);
  if (errors.length) {
    for (const error of errors) console.error(`Mobile configuration: ${error}`);
    process.exitCode = 1;
  } else console.log('iOS/Android identifiers, app version, EAS linkage and all build-profile API URLs are configured. This does not validate signing, credentials, native runtime or store approval.');
}
