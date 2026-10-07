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
