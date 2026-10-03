# Backlog status against the 16-week plan (spec §19)

Legend: ✅ implemented and tested in this repo · 🟡 domain logic done; real adapter or infrastructure still needed · ⬜ not started · 🔒 blocked on an external dependency (account access, provider approval, device, legal review)

| Week | Deliverable | Status | Notes |
|---|---|---|---|
| 1 | Device and account inventory | ✅ / 🔒 | `config/inventory.json`: iPhone 17 Pro Max on AT&T recorded. Still needed from Bruno: iOS version, AT&T number(s), email/calendar/social accounts. Live list at `GET /v1/setup` |
| 1 | Capability matrix | ✅ | Tailored to iOS + AT&T (`docs/SETUP_DESIGN.md`). Nothing is `verified` until tested on real accounts |
| 1 | Operating contract / authority schema | ✅ | `docs/OPERATING_CONTRACT.md`, scoped templates in `src/policy/templates.ts` |
| 1 | Inspect existing assistant code | ✅ | `docs/WORKFORCE_ASSESSMENT.md`: Jarvis and Jarvis-ML are empty; Bruno-AI-Workforce becomes an observe/draft connector. `docs/OPENJARVIS_ASSESSMENT.md`: OpenJarvis used as a reference; security patterns and brief rules ported |
| 1 | Repos and environments | ✅ (not yet applied) | Terraform for staging and prod (Cloud Run, Cloud SQL + PITR, KMS, Secret Manager, keyless GitHub deploys), Dockerfile, manual deploy workflow. Needs a GCP project, then `terraform apply` |
| 2 | Identity, vault, migrations | ✅ | Passkeys (WebAuthn, user verification), device-bound sessions, 5-minute step-up, device revocation; envelope-encrypted vault bound to account and environment (KMS in prod); checksummed migrations |
| 2 | Contact model, event store, audit | ✅ | Postgres: unique-key dedup, leased claiming for multiple workers, durable audit, contacts, rules, action outbox; state rehydrates on boot |
| 2 | Authenticated dashboard | ✅ | Passkey sign-in, step-up prompt on high-risk approvals. Production client is React Native (week 7+) |
| 2 | Synthetic replay without duplicate actions | ✅ | Replay across a restart sends nothing twice; a crash mid-send recovers as `unknown` and is reconciled (`test/integration/durability.test.ts`) |
| 3 | Primary email account: thread ingestion, drafts, payload review | ✅ | Personal Gmail via IMAP IDLE + SMTP with an app password (no Google Cloud project). Sandbox mode, reconcile via Sent Mail, drafts to Gmail Drafts, reconnect handling. Needs Bruno's app password to go live |
| 4 | Calendar, timezones, attachments, reconciliation | 🟡 | Calendar domain + DST done. Still needed: Google Calendar adapter, attachment scanner, and scheduled reconciliation job |
| 4 | Recipient-error prevention, suppression | ✅ | Scenarios C, D |
| 5 | Memory, import, correction, deletion | ✅ | Scenarios I, K. Import review screen UI pending |
| 6 | Durable planning, authority checks, routine execution, cancel, daily summary | 🟡 | Logic done. Swap the interval worker for Temporal (or equivalent) |
| 7 | Voice audition, realtime vs chained prototypes, mobile voice UI | ✅ (realtime) | Female voices Marin/Shimmer/Coral/Sage with auditions; realtime WebRTC with ephemeral keys; installable iPhone app with Talk button. Needs Bruno's listening review |
| 8 | Test phone number, inbound calls, transfer | 🟡 | Call state machine done (Scenario H). Needs telephony provider, SIP → realtime gateway, and legal review |
| 9 | Highest-priority messaging connector | 🔒 | Needs the account inventory. WhatsApp only for an eligible business number |
| 10 | Specialist agents, budgets, context isolation | ✅ | Missions (dot-style always-on agents) with tool-calling loop, budgets, scoped tools, untrusted labeling |
| 11 | Proactive workflows, notifications, contact-specific behavior | 🟡 | Missions scheduler (interval / Rome-time daily) and presets done. Needs push notifications and quiet hours |
| 12 | Feedback capture, style adaptation, eval dashboards | 🟡 | Store + rule proposals + registry done. Needs the eval harness over 200 scenarios |
| 13 | Security hardening, restore exercise | ⬜ | |
| 14 | Controlled real use | 🔒 | |
| 15 | Fine-tuning decision | ⬜ | Default: improve prompts and retrieval first |
| 16 | Production release, runbooks, handover | ⬜ | Runbook outlines in `docs/RUNBOOKS.md` |

## Plan change (3 Oct 2026)

Bruno asked to build autonomously instead of following the weekly order. The priorities are Gmail, Jennifer's voice, the iPhone app and missions. Hosting moves to Render (`render.yaml`) because Bruno doesn't want a Google Cloud project. The Terraform files remain as an alternative.

## Needed from Bruno

1. **OpenAI API key** in the hosting environment (voice and missions).
2. **Deploy** from `render.yaml`, then register a passkey on the iPhone.
3. **Gmail app password** (Google Account → Security → App passwords).
4. **Listen to the four voices** and choose.
5. Later: AT&T number, for phone calls.
