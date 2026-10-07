# Jennifer Mobile

Native Expo/React Native client for the existing Jennifer backend.

## Run
1. cd mobile
2. Copy .env.example to .env and set EXPO_PUBLIC_JENNIFER_API_URL.
3. npm install
4. npm start

The first foundation connects to the existing /health and /v1/chat APIs. Session tokens are designed to be stored with Expo SecureStore; no credentials belong in source control.

## Next
- Native passkey sign-in and step-up approvals
- Today dashboard and action inbox
- Conversation history
- Voice session/turn UI
- Native push adapter
- Explicit contacts/calendar/photos permissions
- EAS iOS and Android build profiles
