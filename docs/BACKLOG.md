# Backlog status against the 16-week plan (spec §19)

Legend: ✅ implemented and tested in this repo · 🟡 domain logic done; real adapter or infrastructure still needed · ⬜ not started · 🔒 blocked on an external dependency (account access, provider approval, device, legal review)

| Week | Deliverable | Status | Notes |
|---|---|---|---|
| 1 | Device and account inventory | 🔒 | Needs Bruno: phone model/OS, carrier, numbers, email providers, social accounts, existing browser-assistant repo |
| 1 | Capability matrix | 🟡 | `src/connectors/capabilities.ts` seeds the matrix with honest statuses. Nothing is `verified` until tested on real accounts |
| 1 | Operating contract / authority schema | ✅ | `src/policy/authority.ts`, `authority_rule` table |
| 1 | Repos and environments | 🟡 | Single repo, CI, `.env.example`. IaC and separate staging/prod credentials still to do |
| 2 | Identity, vault, migrations | 🟡 | Bearer roles + schema with RLS. Still needed: passkeys, device auth, managed vault integration |
| 2 | Contact model, event store, audit | ✅ | Dedup on `(account, provider_event_id)`, append-only redacted audit |
| 2 | Authenticated dashboard | ✅ | `GET /` (minimal). Production client is React Native (week 7+) |
| 2 | Synthetic replay without duplicate actions | ✅ | Tests: duplicate webhook → one reply; Scenario F |
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

## Immediate blockers that need Bruno

1. The account and device inventory: phone model and OS, App Store region, carrier, numbers, email providers, which social accounts are personal and which are business.
2. The URL of the existing browser-assistant repository, for inspection.
3. Standing instructions to activate first (for example, "routine scheduling replies to verified music contacts").
4. Budget ceiling and a choice of telephony provider.
5. Voice audition session: listen to three candidates.
