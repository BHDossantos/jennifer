# Jennifer dependency and release review — November 5, 2026

Base: PR #13, commit `637ac6db884792deca84e80907db11ce1283e8b1`.
Default branch was `57370ab553a6c66bef642353f9c911dc986e3e85` at review.
This candidate preserves PR #13's push/logout fixes and SDK 58 upgrade; it does
not deploy, submit, change production configuration, or establish release readiness.

## Changes and verified checks

- Expo 58.0.22 → 58.0.23, retaining React Native 0.88.1 / React 19.3.0.
- Align linking 58.0.16, notifications 58.1.8, router 58.0.30 and safe-area-context
  5.11.1 to the installed SDK's recommended dependency metadata.
- Align React types to 19.3.0; the prior 19.1.x types violated React Native's
  declared peer range. The final peer dependency check passes.
- Clean locked install, TypeScript and all 28 mobile tests pass; mobile config
  validation and offline `expo install --check` pass. Online Expo compatibility
  metadata was blocked by the environment proxy, so this uses installed SDK
  metadata. No forced major-version overrides were introduced.
- Backend production audit has zero findings; backend typecheck passes. Backend
  code is unchanged. A backend full-suite rerun was not part of this patch.
- Final iOS and Android JavaScript bundle exports pass using an inert
  `https://example.invalid` API URL; no production API or provider was exercised.

The fresh production mobile audit changed from 32 moderate package entries to 5,
with zero high/critical findings before and after. These counts include propagated
dependency paths, not distinct vulnerabilities. The remaining two advisories are:

| Dependency | Installed | Fixed | Remaining path |
| --- | --- | --- | --- |
| glob | 13.0.6 | 14.0.2 | Expo CLI and fingerprint |
| minimatch | 10.2.6 | 11.0.1 | fingerprint and glob |

Sources: [glob cancellation denial of service](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)
and [minimatch globparts amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249).
Their patched major versions are outside the current Expo packages' dependency
ranges. Track upstream compatible releases, then repeat install/audit/native CI;
do not force incompatible tooling changes just to suppress the audit. Restrict
build inputs to trusted project files meanwhile. Dependency presence is verified;
reachability from untrusted app input has not been established. The audit still
returns nonzero because moderate findings remain.

## Release gates and sequence

PR #13's current head has successful historical [Mobile CI](https://github.com/BHDossantos/jennifer/actions/runs/41607274203)
and [CI](https://github.com/BHDossantos/jennifer/actions/runs/41607274102).
Those runs supersede the old readiness note's pending toolchain rerun, but do not
validate this new dependency candidate. Re-run native CI for this commit. Local
JavaScript bundle exports cannot establish native compilation or device behavior.

1. Obtain approval for a backend-only deployment. Verify authenticated native
   push subscribe/unsubscribe endpoints, registration/receipt persistence and
   logout with a disposable paired device against the deployed backend.
2. Review the automatic production trigger before any mobile-branch merge/push.
   `mobile/.eas/workflows/create-production-builds.yml` builds production Android
   and iOS on mobile-path pushes to `claude/new-session-ruep5f` or
   `mobile/jennifer-expo-foundation`. Its iOS job automatically submits to
   TestFlight. It has no backend deployment dependency or explicit approval job.
   Approve gating that workflow separately, or complete backend deployment and
   smoke tests before allowing a triggering mobile push. This review changed no
   workflow or production setting and invoked no build/submission.
3. The separate GitHub `mobile-release.yml` is manually dispatched and defaults
   submission to false; it does not disable the automatic EAS workflow. Production
   EAS profiles target `https://jennifer-29d4.onrender.com`; the manual Cloud Run
   deploy workflow is not evidence that this Render backend is current.
4. After candidate native CI, approve signed builds and verify pairing, audio,
   notifications, logout/unsubscription and WebView on physical iOS/Android
   devices. Provider credentials, release signing, store disclosures and store
   review remain separate, unverified gates. No device QA was performed here.

If mobile is distributed before the backend endpoint update, native registration
can receive 404 and show “Notifications unavailable.” Backend rollback after
distribution also requires coordinated device testing and communication.

Historical audit counts in `READINESS_2026-11-02.md` describe older snapshots.
Use this dated review for the current dependency findings; neither green CI nor
the absence of high-severity audit findings proves production readiness.
