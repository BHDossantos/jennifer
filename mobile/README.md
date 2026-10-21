# Jennifer Mobile

Native Expo/React Native client for Jennifer.

## Implemented
- Ask Jennifer chat connected to /v1/chat
- Today briefing
- Actions queue with guarded approval and cancel flows
- Conversation inbox and message detail
- Missions and run-now
- Pending-memory review/activation
- Voice configuration visibility and native microphone permission
- Native notification permission foundation
- SecureStore session-token storage and logout
- EAS cloud project linkage
- GitHub mobile CI and cloud release workflow
- EAS development, preview and production profiles
- Credential/build-artifact exclusions

## EAS project
Project ID: 2a78c731-c1b8-41d0-8f80-bf97e9fd9949

## Cloud release
Routine releases are designed to run from GitHub Actions, not a developer PC. Add an Expo access token as GitHub Actions secret EXPO_TOKEN. Apple App Store Connect and Google Play service credentials belong in EAS Credentials, never in Git.

## Security gates still to finish
- Native WebAuthn/passkey ceremony for login and step-up
- Native Expo push-token adapter on the Jennifer backend (the current backend push service is web-push)
- Recorded/live voice UX and audio transport
- Store privacy metadata, screenshots, icons and final signed release validation

No API keys, Apple credentials, Google credentials, signing keys, bootstrap tokens or production secrets belong in this repository.

## Connecting the app (TestFlight)

1. In Jennifer on the web (Safari or your computer): **Settings → Connect the iPhone app → Make a code** (Face ID confirms it).
2. Open the app and type the code. It works once and expires after 10 minutes.
3. The app gets its own session, listed under **Settings → Devices** on the web, where you can revoke it.

The server address is baked into every EAS build (`EXPO_PUBLIC_JENNIFER_API_URL` in `eas.json`, default `https://jennifer-29d4.onrender.com`).

## Why the first TestFlight builds were blank

- Two copies of `expo-asset` and `expo-font` were installed (SDK 54's and v57, pulled in through `expo-audio` and `@expo/vector-icons`); the native build linked the wrong ones. They are now pinned to SDK 54 versions.
- The production build had no server address, and there was no sign-in, so every request failed.
- The Today screen rendered an object as text, which crashes a release build with no visible error. An app-wide error screen now replaces any crash.

## Validation before a release

From this directory, run `npm ci`, `npm run check:config`, `npm test`,
`npm run export:ios`, and `npm run export:android`.

GitHub **Jennifer Mobile CI** now runs on mobile pull requests, manual dispatch,
and mobile changes to the actual default branch. It has no store credentials:

1. Locked dependency installation, configuration checks, typechecking, and mocked
   API regression tests (pairing on both platforms, revoked sessions, offline and
   malformed responses, guarded action approval).
2. Separate iOS and Android JavaScript bundle exports.
3. An Android debug APK compile and an unsigned iOS simulator app compile, with
   seven-day artifacts tied to the commit SHA.

The APK uses Android's generated debug signing identity, not the Play upload key.
Both native artifacts are development builds and need Metro for runtime testing;
run `npm start` from this directory on the machine used for testing. Simulator
builds cannot be installed on a physical iPhone. Exported JavaScript bundles are
not IPA/AAB artifacts. None of these steps submits to EAS, TestFlight, or Play.

The API tests mock native modules and network: they do not establish real-device
behavior or call the live service. Native compilation is also not a UI test.
Before a paid/public release, record the commit/build ID and test pairing,
logout/revocation, offline/retry, blank-screen/crash recovery, navigation/back,
microphone denial and re-enable, voice interruption, notification permission,
and action approval/cancel on both iOS and Android devices.

### Remaining release evidence

- Replace default/generated branding with approved app icons and launch assets.
- Verify signed IPA/AAB, current Apple/Google credentials, TestFlight/Play receipt,
  store metadata/privacy forms and screenshots for the exact release commit.
- Verify push delivery, microphone/audio runtime and supported device versions.
- Confirm pricing, in-app purchase/subscription implementation and restore flow
  if monetization is required. The existing assistant client is not evidence of
  a completed purchase flow.

The manual GitHub **Jennifer Mobile Release** workflow is one signed-build/store-testing
path and now runs the same checks first. Running it may consume EAS build quota.
The new GitHub validation jobs themselves never submit or publish a build.

**Merge gate: an existing Expo-hosted production workflow is also present.**
`mobile/.eas/workflows/create-production-builds.yml` watches mobile changes on
`claude/new-session-ruep5f` and `mobile/jennifer-expo-foundation`; it creates
production Android/iOS builds and submits iOS to TestFlight if the integration
is enabled. The isolated audit branch is not a matching trigger. Do not merge
mobile changes into those branches until the owner has reviewed this release
gate. This audit does not modify or disable that production workflow.

The API URL validator checks HTTPS syntax, absence of embedded credentials and
common local hostnames only. It does not resolve DNS or establish public
reachability, API health, authentication or network security.
