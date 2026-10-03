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
| 3 | Primary email account: thread ingestion, drafts, payload review | 🟡 | Pipeline + fake provider done. Gmail API adapter (watch/history/renewal) to build; start Google OAuth verification **now** |
| 4 | Calendar, timezones, attachments, reconciliation | 🟡 | Calendar domain + DST done. Still needed: Google Calendar adapter, attachment scanner, and scheduled reconciliation job |
| 4 | Recipient-error prevention, suppression | ✅ | Scenarios C, D |
| 5 | Memory, import, correction, deletion | ✅ | Scenarios I, K. Import review screen UI pending |
| 6 | Durable planning, authority checks, routine execution, cancel, daily summary | 🟡 | Logic done. Swap the interval worker for Temporal (or equivalent) |
| 7 | Voice audition, realtime vs chained prototypes, mobile voice UI | ⬜ | Persona config and multilingual greetings ready. Needs voice candidates and Bruno's listening review |
| 8 | Test phone number, inbound calls, transfer | 🟡 | Call state machine done (Scenario H). Needs telephony provider, SIP → realtime gateway, and legal review |
| 9 | Highest-priority messaging connector | 🔒 | Needs the account inventory. WhatsApp only for an eligible business number |
| 10 | Specialist agents, budgets, context isolation | 🟡 | Coordinator done. Needs the LLM tool-use loop wired to `ToolRegistry` |
| 11 | Proactive workflows, notifications, contact-specific behavior | 🟡 | Registry + scheduling done. Needs push notifications and quiet hours |
| 12 | Feedback capture, style adaptation, eval dashboards | 🟡 | Store + rule proposals + registry done. Needs the eval harness over 200 scenarios |
| 13 | Security hardening, restore exercise | ⬜ | |
| 14 | Controlled real use | 🔒 | |
| 15 | Fine-tuning decision | ⬜ | Default: improve prompts and retrieval first |
| 16 | Production release, runbooks, handover | ⬜ | Runbook outlines in `docs/RUNBOOKS.md` |

## Needed from Bruno to start Week 3 (email)

1. **Which email account is Jennifer's primary?** Your personal Gmail, or the Thrust insurance mailbox (Google Workspace)? Workforce already uses both.
2. **Google Cloud project** for Jennifer (or reuse the Workforce project), so the OAuth client can be created and **Google's restricted-scope verification can start now**. It takes weeks.
3. **iOS version** and your **AT&T number** (for the Week 8 forwarding plan).
4. **Apple Developer Program** membership (needed by Week 7).
5. Fix Workforce's unsigned carrier webhooks and plaintext secrets before connecting the two systems (`docs/WORKFORCE_ASSESSMENT.md`).
