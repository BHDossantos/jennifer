# Spec coverage

How each section of *Jennifer Virtual Assistant Developer Specification* (v1, 30 Sep 2026) maps to this repository. Status values:

- **Built**: implemented and covered by automated tests.
- **Built, conditional**: implemented; it only works once a provider account, key or approval exists (listed under "Needs Bruno").
- **Partial**: the core is built; the listed piece is not.
- **Deviation**: built differently from the recommendation, with the reason.
- **Not built**: deliberately left out, with the reason and the alternative.

Test counts at the time of writing: 343 automated tests, including the 204-scenario evaluation suite (`npm run eval` writes `evals/report.json`; 204/204 pass, 0 critical failures).

| § | Requirement | Status | Where | Tests |
|---|---|---|---|---|
| 1 | Four modes (observe, draft, execute, ask) per account, contact, workflow, action type | Built | `src/policy/authority.ts` | `test/acceptance`, `test/evals` (authority family) |
| 1 | Machine-readable authority registry; server-side check on every write; model cannot grant itself permission | Built | `authority.ts`, `src/actions/service.ts` | acceptance, evals |
| 1 | Default templates (routine scheduling/admin replies); money, signatures, security, mass outreach, ID/financial documents behind specific authority | Built | `src/policy/templates.ts`, `HIGH_RISK_ACTIONS` | evals (financial family) |
| 1 | Permission changes affect queued and running tasks; revoked actions cannot run; every send traceable to rule or approval | Built | `service.ts` re-checks at execution; receipts carry `authorityRuleId`/`approvalId` | evals `authority-revoked-after-queue` |
| 2 | Setup checklist (device, OS, carrier, numbers, accounts, existing code) | Built | `config/inventory.json`, `src/setup/inventory.ts`, `GET /v1/setup`, onboarding card | `test/unit/setup.test.ts` |
| 2 | Per-connector capability matrix (read, draft, send, attachment, webhook, history import, search, delete, call) with verified/conditional/unavailable/disconnected | Built | `src/connectors/capabilities.ts` (Gmail, Outlook, calendars, telephony, SMS, WhatsApp, iMessage, Instagram, Facebook, LinkedIn, X, Telegram, iOS app, Workforce) | core tests |
| 2 | Separate spaces (personal, insurance, music, restaurant, nonprofit, technology); merge only on verified identifiers | Built | `src/core/types.ts`, `src/contacts/contacts.ts` | evals (cross-project, two Annas) |
| 2 | Live capability screen with last successful sync | Built | Connections tab, `GET /v1/connections` | api tests |
| 3 | TypeScript API + dashboard; PostgreSQL with vector search; vault; durable workers; containers | Built | `src/`, `db/migrations`, `src/identity/vault.ts`, `Dockerfile` | durability tests |
| 3 | React Native mobile client | **Deviation** | Installable PWA (`src/api/dashboard.ts`, `pwa.ts`): no Apple Developer account needed now; push, voice and passkeys work from the Home Screen on iOS 26. A native app remains possible later | api, voice tests |
| 3 | Durable workflow engine (Temporal optional) | Deviation | Postgres outbox + leased event store + timers in `src/api/main.ts`; no Temporal until operational evidence justifies it | durability tests |
| 3 | Dev/staging/prod with separate credentials; IaC; reviewed migrations; dependency scanning; locked manifest | Built | `render.yaml`, `deploy/terraform`, checksummed migrations, `npm audit` in CI, `package-lock.json` | migration tamper test |
| 3 | Local simulator with fake inboxes and calls; developer README | Built | `src/simulator`, `README.md` | — |
| 4 | Passkeys; step-up for sensitive actions; device-bound sessions; remote device revocation | Built | `src/identity/identity.ts`, server step-up | `test/integration/identity*.test.ts` |
| 4 | OAuth + PKCE where applicable | Not needed now | Gmail uses an app password (no Google Cloud project, Bruno's choice); calendars use app-specific password / secret iCal URL. The vault and connector binding are ready for OAuth later | — |
| 4 | Owner/developer/operator roles; developers see redacted diagnostics only | Built | `src/api/server.ts` roles | api tests |
| 4 | Secrets in an encrypted vault bound to account and environment; never in prompts/logs; redaction filter | Built | `vault.ts`, `src/security/redaction.ts` | core tests |
| 4 | Unusual access alerts | Built | new device, repeated sign-in failures, dormant device → urgent notice (SMS fallback) | `apiIdentity.test.ts` |
| 4 | Key rotation, access reviews | Partial | vault supports multiple key versions (`JENNIFER_VAULT_KEYS`); rotation is a runbook step, no scheduled access-review report yet | — |
| 5 | Common event envelope; signature + timestamp verification; commit before ack; async processing | Built | `src/events/events.ts`, webhooks in `server.ts` | api tests |
| 5 | Dedup, outbox, serialized conflicting actions, message revisions, context invalidation | Built | `service.ts`, `conversations.ts` | evals (idempotency, context-changed) |
| 5 | Action states incl. unknown; reconcile before retry; capped backoff with jitter; dead-letter queue with visible recovery | Built | `service.ts`, `GET /v1/dead-letters`, retry/dismiss in Settings | gmail + sms reconciliation tests, api tests |
| 6 | Gmail: push notifications + history cursor + periodic sync | Built (deviation) | IMAP IDLE + UID cursor + 5-min poll instead of Pub/Sub watch (no Google Cloud project) | `test/integration/gmail.test.ts` |
| 6 | Microsoft Graph mail/calendar | Not built | Bruno has no Microsoft account in scope; capability row says so | — |
| 6 | Threading, reply headers, recipients, CC/BCC, attachment metadata; reply vs reply-all explicit | Built | `src/connectors/gmail/*`, `sendMessage.ts` | gmail tests |
| 6 | Exclude bounces, lists, out-of-office; detect spoofed names and lookalike addresses | Built | `classifyAutomatedEmail`, `assessSender` | evals (automated, spoofing) |
| 6 | Attachment scanning; isolated parsing | Partial | attachments stay `pending` until scanned and cannot be sent unscanned; no antivirus engine is wired yet | evals cross-project |
| 6 | Validate claims; never invent payments/returns/submissions | Built | `src/security/claims.ts` (EN/IT/PT/ES) | evals (unsupported claims) |
| 6 | Calendar: free/busy, create/modify, attendees, recurrence, DST, travel buffers, conflicts; UTC + IANA zone + original local time | Built | `src/calendar/*` (iCloud CalDAV read/write, Google secret iCal read-only) | `calendar.test.ts`, evals (Rome time) |
| 6 | Manual replies cancel redundant pending responses | Built | Gmail Sent-folder sync → `handleSent` | gmail test |
| 7 | SMS and voice on a provider number; no change to Bruno's AT&T line | Built, conditional | `src/connectors/sms/twilio.ts`, `/v1/webhooks/sms`, `src/voice/phone.ts`; AT&T conditional forwarding codes in setup | `sms.test.ts`, `phone.test.ts` |
| 7 | Personal iMessage/SMS on iPhone | Not available | iOS gives apps no Messages inbox; Jennifer offers "Send from my iPhone" handoff (`sms:` link) for SMS drafts | capability row |
| 7 | WhatsApp Business; personal WhatsApp | Conditional / unsupported | capability rows; adapter not built until an eligible business number exists | — |
| 7 | Instagram, Facebook, LinkedIn, X, Telegram investigations | Built (as investigations) | capability rows with account-type and review requirements; draft-only until approved | — |
| 7 | No screen scraping or broad accessibility permissions | Built | no such code; generic tools are refused by `ToolRegistry` | core tests |
| 8 | Feminine voice candidates chosen by listening; private vs business; controls (warmth, rate, playfulness, verbosity) | Built | Voice tab, `src/voice/persona.ts`, `realtime.ts` (marin, shimmer, coral, sage) | voice tests |
| 8 | Realtime speech-to-speech and chained ASR→LLM→TTS, prototyped both | Built | Talk button (WebRTC realtime) and Hold-to-talk (`src/voice/chained.ts`, `/v1/voice/turn`) with per-stage latency | voice tests |
| 8 | Interruption, VAD, muted/offline states, text fallback, pronunciations, language switching | Built | server VAD with interrupt, visible states, chat fallback, pronunciation dictionary, EN/PT-BR/ES/IT | voice tests |
| 8 | Four-language listening samples; human listening review | Needs Bruno | audition plays each voice in each language; Bruno chooses | — |
| 9 | Incoming SIP calls: signed webhook, accept/reject/transfer/hangup, AI disclosure, message taking, caller ID as hint only | Built, conditional | `src/voice/phone.ts` | `phone.test.ts` |
| 9 | Warm transfer with failure → message + follow-up; no callback promises | Built | `transfer_to_bruno`, notifications | phone tests |
| 9 | Per-call duration limit; silence/drop handling | Built | wrap-up warning then hangup (`JENNIFER_CALL_MAX_MINUTES`) | phone test |
| 9 | Recordings off by default; transcript retention | Built | no recording; call log retention 90 days | ops tests |
| 9 | Outbound calls | Not built | needs an explicit workflow, permitted recipients and legal review (spec) — intentionally absent | — |
| 10 | Memory classes with source, evidence, times, confidence, sensitivity, retention, supersession | Built | `src/memory/memory.ts` | core, acceptance |
| 10 | Vector retrieval filtered by account/project/contact/sensitivity before ranking | Built | pgvector + embedder; filters first | evals cross-project |
| 10 | Conflicts → review items; expiry; inspect, correct, export, delete with deletion ledger | Built | Memory tab (correct, forget, export), `/v1/memory/*` | api + acceptance (Scenario K) |
| 11 | No account scraping or cookie reuse; explicit context bridge | Built | see README "ChatGPT and Claude" | — |
| 11 | Import ChatGPT export and selected conversations; checksum; dedup; timestamps; review before activation; deletable | Built | `src/memory/aiHistory.ts` (ChatGPT **and Claude**, incl. Claude projects), Memory tab | `aiHistory.test.ts`, acceptance |
| 11 | "Send this to Jennifer" endpoint | Built | `/v1/history/clip` + Share Sheet clip token | aiHistory test |
| 11 | Reasoning through the supported API with model/prompt version recorded | Built | OpenAI or Claude (`MODEL_PROVIDER`), versions in audit and feedback | anthropic tests |
| 11 | Answer from imported history with source; admit missing history | Built | `search_ai_history` / `read_ai_conversation` tools | aiHistory test |
| 12 | Specialist roles with narrow tools; task envelopes; budgets; depth caps; cancellation | Partial | `src/agents/agents.ts` (coordinator + roles); chat and missions run as single agents with narrowed tool sets and budgets rather than through the coordinator | core tests |
| 12 | Plain-language activity ("Checking your calendar") | Built | mission activity feed, Today | missions tests |
| 13 | Feedback capture (accepted, edited, rejected, wrong fact/recipient, tone…) with original, final, sources, policy, model version | Built | automatic on approve/edit/decline (`src/app.ts`), decline reasons in UI | api tests |
| 13 | Repeated corrections → proposed rules; style auto-applies; authority/contact changes need approval; other people cannot change preferences | Built | `src/learning/feedback.ts`, Settings → What Jennifer learned | api + durability tests |
| 13 | Train/validation/test splits; model registry with rollback | Built (no fine-tuning) | `trainingSplit`, `ModelRegistry`; fine-tuning deferred until there is consented data (spec week 15 decision) | core tests |
| 14 | Today, Conversations, Tasks, Calls, Memory, Connections, Settings; persistent voice button with states | Built | dashboard tabs (Inbox = Conversations), Talk button states | manual browser run, api tests |
| 14 | Approval cards with exact recipient, account, text, attachments, consequences, expiry; editing invalidates approval | Built | `approvalCard`, Edit → new revision | api tests, evals |
| 14 | Global, per-connector, per-contact pause; emergency stop; explain limits | Built | Settings, durable across restarts | durability test |
| 14 | Accessibility (keyboard, screen readers, contrast, reduced motion, large text) | Partial | semantic buttons, aria-live status, aria labels, system fonts/dark mode; no formal audit yet | — |
| 15 | Required entities with owner/scope; versioned endpoints; ownership checks; tool contracts | Built | `db/migrations/0001_init.sql` + later migrations, `docs/API.md`, `src/tools/registry.ts` | api tests |
| 16 | Stored workflows with triggers, stop conditions, follow-up limits; templates; durable workers | Built | `src/workflows/workflows.ts`, missions (`src/missions`) | missions tests |
| 16 | Persistent suppression across workflows; stop-request recognition | Built | `SuppressionList` (durable), EN/IT/PT/ES | evals (suppression), durability |
| 16 | Daily brief distinguishing "no email" vs "disconnected"; notifications with dedup, quiet hours, urgency, fallback channel | Built | `buildDailyBrief`, `src/notify/push.ts` + SMS fallback | acceptance J, push + sms tests |
| 17 | Untrusted content labeled; permissions in code; egress rules; no script execution | Built | `src/security/untrusted.ts` (multilingual), `safeFetchText` (DNS + redirect checks) | evals (adversarial), core tests |
| 17 | Retention per data class | Built | `src/ops/retention.ts` (messages 365d, calls 90d, audit 730d, feedback 365d; configurable) | ops tests |
| 17 | Privacy/communications legal review | Needs Bruno | deployment prerequisite (README) | — |
| 18 | Targets and measurements (ack/triage latency, stuck tasks, ambiguous sends, cost per task) | Built | `GET /v1/metrics`, `src/ops/metrics.ts` | ops tests |
| 18 | Monthly ceiling; per-task, per-call and agent budgets | Built | `src/ops/costs.ts` (stops optional model work at the ceiling), mission budgets, call limit | ops tests |
| 18 | Backups, restore practice (RPO 15 min, RTO 4 h) | Partial | Render managed Postgres backups / Terraform `backup_configuration`; restore runbook; restore drill not yet performed | — |
| 19 | Ordered backlog | Replaced | Bruno asked to build everything autonomously; see `docs/BACKLOG.md` | — |
| 20 | ≥200 curated scenarios incl. multilingual and adversarial; Scenarios A–K | Built | `test/evals` (204), `test/acceptance/scenarios.test.ts` (A–K) | `npm run eval` |
| 21 | Handover: code, IaC, migrations, API spec, capability matrix, authority rules, prompt/model versions, import procedure, eval reports, deployment, cost dashboard, runbooks | Built | this repo, `docs/API.md`, `docs/RUNBOOKS.md`, Settings → This month | — |

## Needs Bruno (in this order)

1. Deploy on Render (Blueprint) and set `OPENAI_API_KEY` (and optionally `ANTHROPIC_API_KEY`).
2. Register the passkey on the iPhone and add Jennifer to the Home Screen.
3. Choose the voice by listening (four voices, four languages).
4. Connect Gmail (app password) and calendars (iCloud app-specific password; Google secret iCal URL).
5. Turn on notifications.
6. Upload your ChatGPT and Claude exports; approve suggested memories.
7. Optional: phone number (SignalWire/Twilio), `OPENAI_WEBHOOK_SECRET`, SMS variables, AT&T forwarding after a test call.
8. Before live use with other people: legal review of calls, recording and data handling (Italy, US).
