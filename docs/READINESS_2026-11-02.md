# November 2 release-readiness fixes

Draft branch `fix/store-readiness-20261102` builds on PR #7's validation work and
preserves default commit `57370ab553a6c66bef642353f9c911dc986e3e85`.
No merge, deployment, EAS production build, TestFlight submission, signing-secret
change, or store-setting change was performed.

**Do not merge without a release decision.** The existing Expo-hosted workflow
`mobile/.eas/workflows/create-production-builds.yml` matches mobile changes on
`claude/new-session-ruep5f` and `mobile/jennifer-expo-foundation`, builds both stores
and submits iOS to TestFlight when integrated with EAS. This draft branch matches
neither. The production trigger was left unchanged.

## Changes

- Retains PR #7's iOS simulator/Android debug validation, locked installs, bundle
  exports, configuration checks and mobile regression tests.
- Updates compatible backend dependencies and requires Zod >=4.6.6. The final
  production dependency audit reports zero vulnerabilities.
- Reuses the existing `src/api/pwa.ts` Jennifer waveform artwork as a 1024px app
  icon, validates its presence/dimensions, and adds the SDK-compatible
  `expo-system-ui` dependency. No new brand design was introduced.
- Native notification registration now obtains an Expo token after permission
  and Android channel setup, registers it through a session-authenticated API,
  and only reports success after the server accepts it. Registrations belong to
  the current device, replace rotated tokens and expire with the session.
- Logout and device revocation unregister native notifications. Delivery checks
  current device revocation, honors existing quiet hours and privacy preferences,
  preserves urgent fallback, and tracks Expo tickets for delayed receipt checks.
  DeviceNotRegistered removes only the affected token; stale receipts cannot
  delete a replacement token. Failed sends no longer consume the deduplication
  key, allowing a subsequent attempt. An accepted ticket is not device-delivery
  proof. Subscription/receipt mutations are serialized within the server process;
  cross-process coordination remains a consideration before horizontally scaling.

## Validation and remaining gates

Local locked installs, backend/mobile type checks, 28 mobile tests, both native
Hermes bundle exports and Expo prebuild passed. Generated iOS icon is 1024px RGB
(no alpha channel). Targeted push/API tests passed 10/10. Workflow YAML and Bash
syntax checks passed. The initial readiness head `478818a` passed the full backend suite: 555/555 tests across 33 files. Tests mock Expo delivery;
no real device is contacted. Native simulator/debug build evidence from PR #7
belongs to its prior commit and must not be represented as current signing proof.

The mobile production dependency audit still reports **36 advisories: 7 high,
28 moderate, 1 low**. A broad `npm audit fix` attempted incompatible nested React
Native peer upgrades; that attempt was discarded. The final mobile lockfile
preserves the SDK 54 dependency graph and adds only expo-system-ui. A coordinated
Expo/React Native upgrade and device regression pass remain release blockers;
forcing Router 58 alone is not a compatible fix. The backend audit is separate
and clean.

Native delivery still requires APNs/FCM credentials for the existing EAS project,
including Android Firebase service configuration. If Expo enhanced push security
is enabled, configure `JENNIFER_EXPO_ACCESS_TOKEN` in the server secret store.
No credentials were read or changed. Test physical devices, token rotation,
permission denial, expiration, logout/revocation, foreground/background delivery,
receipt failures and microphone/audio. Registration is user-initiated in Settings;
re-enable there after reconnecting or changing notification permissions.

Before public store release, verify signing/build numbers, support/privacy URLs,
privacy/Data Safety declarations and any required deletion request path, reviewer
pairing access, screenshots and distribution eligibility for this owner-bound
assistant. Those store decisions and any signed build/submission require approval.


## Logout review fix and release sequencing

Logout now revokes the server bearer session before attempting native push cleanup.
A cleanup exception emits a generic warning and does not undo or prevent logout;
actual session-revocation failures still fail the request. Regression tests use
real database-backed sessions and verify that the old bearer token is rejected
both when cleanup succeeds and when notification storage throws. Follow-up
TypeScript and all 12 targeted pairing/logout/native/web-push tests passed;
`git diff --check` passed. Push cleanup is
best effort: a failed cleanup can leave a registration until expiry or a later
successful cleanup; the warning must not be treated as proof of unsubscription.

Release the backend first, only after explicit deployment approval. Verify the
new authenticated `/v1/push/native/subscribe` and `/unsubscribe` endpoints,
registration/receipt persistence, and logout with a disposable paired device.
Then approve the mobile release trigger/TestFlight build and test against that
backend. Merging this PR can trigger EAS/TestFlight before a manually deployed
backend is updated, so merge timing alone is not a safe release gate. Prepare a
backend-only release first, or separately approve gating the EAS workflow before
merging mobile changes; neither action was performed here.

If the new mobile app reaches an older backend first, registration receives 404
and Settings shows “Notifications unavailable”; it does not claim successful
registration. Core existing API calls remain unchanged, but native notifications
are not ready. Avoid distributing the mobile build until the endpoint smoke tests
pass. A backend rollback after mobile rollout likewise leaves registration
unavailable; coordinate rollback and tester communication.
