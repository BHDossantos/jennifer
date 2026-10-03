# Jennifer API (v1)

Generated from `src/api/server.ts` (`npx tsx scripts/api-doc.mts > docs/API.md`). Every `/v1` read and mutation requires a bearer token: a passkey session (owner), or a static token for the developer/operator roles, which never see correspondence. Sensitive changes (connecting accounts, authority grants, device revocation, adding passkeys, non-style learned rules) also require a passkey step-up within the last five minutes. Provider webhooks are verified by signature instead (HMAC for email ingestion, Standard Webhooks for OpenAI calls, Twilio/SignalWire signature for SMS).

Errors are JSON: `{ "error": "<code>", "message": "..." }` — `409` for policy/state refusals (e.g. `approval.stale`, `approval.step_up_required`, `budget.ceiling_reached`), `404` for `*.not_found`, `400` with `issues` for invalid input, `401/403` for authentication and role.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | public |  |
| GET | `/` | public |  |
| GET | `/manifest.webmanifest` | public |  |
| GET | `/sw.js` | public |  |
| GET | `/icon-192.png` | public |  |
| GET | `/icon-512.png` | public |  |
| GET | `/apple-touch-icon.png` | public |  |

### Today / Connections

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/today` | owner |  |
| GET | `/v1/connections` | owner, developer, operator |  |
| GET | `/v1/onboarding` | owner | First-run checklist: Bruno's remaining setup steps, with live status. |
| GET | `/v1/setup` | owner |  |

### Actions & approvals

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/actions` | owner |  |
| GET | `/v1/actions/:id` | owner |  |
| POST | `/v1/actions/:id/approve` | owner |  |
| POST | `/v1/actions/:id/edit` | owner |  |
| POST | `/v1/actions/:id/cancel` | owner |  |

### Conversations

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/conversations` | owner |  |
| GET | `/v1/conversations/:id` | owner | Conversation detail: messages in order with drafts, attachments and receipts. |
| GET | `/v1/contacts` | owner |  |

### Problems: dead letters with a recovery action

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/dead-letters` | owner |  |
| POST | `/v1/dead-letters/:id/dismiss` | owner |  |
| POST | `/v1/dead-letters/:id/retry` | owner | Retry = a fresh proposal of the same action, which waits for Bruno's explicit decision. |

### Operations: reliability and cost (spec §18)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/metrics` | owner, developer, operator | No correspondence here, so operators may read it too. |
| GET | `/v1/costs` | owner |  |

### Learning: feedback and proposed rules

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/feedback` | owner |  |
| POST | `/v1/feedback/rules/:id` | owner |  |

### Identity: passkeys, step-up, devices

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/auth/passkeys/register/options` | owner |  |
| POST | `/v1/auth/passkeys/register/verify` | owner |  |
| POST | `/v1/auth/passkeys/login/options` | public (passkey challenge) |  |
| POST | `/v1/auth/passkeys/login/verify` | public (passkey challenge) |  |
| POST | `/v1/auth/step-up/options` | owner |  |
| POST | `/v1/auth/step-up/verify` | owner |  |
| POST | `/v1/auth/logout` | owner |  |
| GET | `/v1/devices` | owner |  |
| DELETE | `/v1/devices/:id` | owner |  |

### Voice

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/voice` | owner |  |
| PUT | `/v1/voice/settings` | owner |  |
| GET | `/v1/voice/audition` | owner |  |
| POST | `/v1/voice/turn` | owner |  |
| POST | `/v1/voice/usage` | owner | The app reports how long a live voice conversation lasted (cost ledger). |
| POST | `/v1/voice/session` | owner |  |
| POST | `/v1/voice/tools/:name` | owner | Tool calls from a live voice session run here, through the same registry and policy as everything else. |

### Push notifications

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/push/key` | owner |  |
| POST | `/v1/push/subscribe` | owner |  |
| POST | `/v1/push/unsubscribe` | owner |  |
| POST | `/v1/push/test` | owner |  |
| GET | `/v1/notifications/prefs` | owner |  |
| PUT | `/v1/notifications/prefs` | owner |  |

### Chat ("Ask Jennifer")

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/chat` | owner |  |
| GET | `/v1/memory/pending` | owner |  |
| POST | `/v1/memory/:id/activate` | owner |  |

### Missions (always-on agents)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/missions` | owner |  |
| POST | `/v1/missions` | owner |  |
| GET | `/v1/missions/:id` | owner |  |
| POST | `/v1/missions/:id/run` | owner |  |
| POST | `/v1/missions/:id/results/:rid` | owner |  |

### Connectors: Gmail

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/connectors/gmail` | owner |  |
| POST | `/v1/connectors/gmail/connect` | owner |  |
| POST | `/v1/connectors/gmail/disconnect` | owner |  |
| POST | `/v1/connectors/gmail/sync` | owner |  |
| POST | `/v1/connectors/gmail/import` | owner |  |

### Connectors: calendars

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/connectors/calendar` | owner |  |
| POST | `/v1/connectors/icloud-calendar/connect` | owner |  |
| POST | `/v1/connectors/calendar-feed/connect` | owner |  |
| POST | `/v1/connectors/calendar/sync` | owner |  |
| POST | `/v1/connectors/calendar/:id/disconnect` | owner |  |

### Authority registry

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/authority` | owner |  |
| POST | `/v1/authority` | owner |  |
| POST | `/v1/authority/templates/:templateId` | owner |  |
| DELETE | `/v1/authority/:id` | owner |  |

### Controls

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/controls/emergency-stop` | owner |  |
| POST | `/v1/controls/pause` | owner |  |
| POST | `/v1/controls/resume` | owner |  |
| POST | `/v1/suppressions` | owner |  |

### Memory

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/memory` | owner |  |
| GET | `/v1/memory/:id/why` | owner |  |
| DELETE | `/v1/memory/:id` | owner |  |
| GET | `/v1/memory/reviews` | owner |  |
| POST | `/v1/memory/:id/correct` | owner | Bruno corrects a memory: the old entry is superseded, never silently overwritten. |
| GET | `/v1/memory/export` | owner |  |

### ChatGPT / Claude history (explicit exports and shared clips)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/memory/import/chatgpt` | owner | Legacy: raw ChatGPT conversations.json text. |
| POST | `/v1/history/import` | owner | Upload the export as downloaded: the .zip (base64) or conversations.json (+ Claude projects.json). |
| POST | `/v1/history/import-zip` | owner |  |
| POST | `/v1/history/clip-token` | owner |  |
| POST | `/v1/history/clip` | owner or clip token |  |
| GET | `/v1/history/search` | owner |  |
| GET | `/v1/history/conversations` | owner |  |
| GET | `/v1/history/conversations/:id` | owner |  |
| POST | `/v1/history/conversations/:id/suggest-memories` | owner |  |
| GET | `/v1/history/projects` | owner |  |
| GET | `/v1/history/imports` | owner |  |
| DELETE | `/v1/history/imports/:id` | owner |  |

### Audit

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/audit` | owner, developer, operator |  |

### Phone calls (OpenAI Realtime SIP)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/webhooks/openai` | provider signature | Signed by OpenAI (Standard Webhooks); no bearer auth. |
| GET | `/v1/calls` | owner |  |

### Provider webhooks

| Method | Path | Auth | Notes |
|---|---|---|---|

### SMS to Jennifer's number (Twilio / SignalWire signed webhook)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/webhooks/sms` | provider signature |  |
| POST | `/v1/webhooks/email/:connectorId` | provider signature |  |
