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
