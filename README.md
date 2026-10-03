# Jennifer

Bruno's persistent executive assistant: backend foundation, policy engine, durable action pipeline and local simulator, built from the *Jennifer Virtual Assistant Developer Specification* (v1, 30 Sep 2026).

> **Status:** usable on Bruno's iPhone once deployed (see below). Built so far:
> - **Gmail:** your personal inbox over IMAP push + SMTP with a Google app password. No Google Cloud project.
> - **Voice:** a female realtime voice (Marin by default; audition Shimmer, Coral, Sage) with private and business personas.
> - **Missions:** always-on agents similar to ChatGPT "dots".
> - **App:** an installable home-screen app.
> - **Foundation:** passkey sign-in, an encrypted vault, and a durable Postgres action pipeline.
>
> Calendar, phone calls and messaging connectors are next. See [`docs/BACKLOG.md`](docs/BACKLOG.md).

## Put Jennifer on your iPhone

1. **Deploy:** on [Render](https://render.com), New → Blueprint → this repo (`render.yaml`: HTTPS service + Postgres). Paste `OPENAI_API_KEY`. Optionally set `JENNIFER_EMAIL_SANDBOX` to your own address for the first days.
2. **Register your passkey:** on the iPhone, open the service URL in Safari and tap **Sign in with passkey**. The first time it asks for the bootstrap token (Render → Environment → `JENNIFER_API_TOKEN`) and registers Face ID.
3. **Install:** Share → **Add to Home Screen**. Jennifer now opens full-screen like an app.
4. **Voice:** in the **Voice** tab, play the four voices and choose one. Tap **Talk** anywhere to speak with her.
5. **Gmail:** Google Account → Security → 2-Step Verification → **App passwords** → create "Jennifer". In **Connections**, paste your address and the app password.
6. **Missions:** in **Missions**, start "Inbox watch" or "Morning priorities", or write your own goal and choose what she may do alone.

## Core rule

The language model can only **propose** actions. Every external write goes through one deterministic executor. Just before the connector sees the request, the executor re-checks:

1. the global, connector and contact pause switches and the emergency stop
2. the persistent suppression list ("stop contacting X")
3. whether the conversation context changed (a new inbound message invalidates a queued reply)
4. recipient verification, attachment space and scan status, and unsupported factual claims
5. the **authority registry**: a live standing rule, or an approval bound to this exact revision and payload hash
6. the payload hash itself

Ambiguous provider results (timeouts) are **reconciled** before any retry. Nothing is blindly resent.

## Quick start

```bash
npm install
npm test            # 89 tests: acceptance A–K, Postgres, passkeys, Gmail (local IMAP/SMTP), voice, missions
npm run typecheck
npm run simulate    # end-to-end walkthrough against the fake inbox
npm run dev         # API + dashboard on http://localhost:8787, durable (PGlite in .data/ or DATABASE_URL)
```

Node ≥ 20. Copy `.env.example` to `.env` for configuration. Set `JENNIFER_SEED=1` to load simulator demo data (never with a real inbox).

## Layout

| Path | Spec | What it does |
|---|---|---|
| `src/policy/authority.ts` | §1 | Authority registry: observe / draft / execute / ask, scope, limits, expiry, revocation, policy versions |
| `src/policy/controls.ts` | §14, §16 | Global, connector and contact pause; emergency stop; persistent suppression list |
| `src/actions/` | §5, §15 | Action state machine, approvals bound to revision and hash, final executor, retries, reconciliation, dead letters |
| `src/events/` | §5, §6 | Event envelope, webhook signature verification, dedup store, conversations, automated-mail detection |
| `src/contacts/` | §2, §6 | Verified identities, same-name disambiguation, merge only on verified IDs, spoof and lookalike detection |
| `src/connectors/` | §2, §7 | Capability matrix (verified / conditional / unavailable / disconnected), connector contract, fake email provider |
| `src/calendar/` | §6 | UTC + IANA zone + original local time, DST-gap rejection, conflicts, travel buffers, slot suggestions |
| `src/memory/` | §10, §11 | Scoped memory (filter before ranking), sources and `why()`, conflicts, expiry, deletion ledger, ChatGPT export import |
| `src/security/` | §4, §17 | Secret redaction, untrusted-content wrapping and injection flags, egress rules, fabricated-claim guard |
| `src/tools/` | §15 | Typed tool registry: schemas, scopes, timeouts, rate limits, side-effect classes, no generic "run anything" tool |
| `src/agents/` | §12 | Task envelopes, narrowed specialist scopes, depth, tool and cost budgets, cascading cancellation |
| `src/workflows/` | §16 | Proactive workflows (confirmed only), DST-safe scheduling, follow-up caps, daily brief |
| `src/voice/` | §8, §9 | Persona (private vs business), greetings in 4 languages, call state machine, barge-in, transfer fallback |
| `src/learning/` | §13 | Feedback capture, scoped rule proposals, leakage-safe splits, model registry with gates and rollback |
| `src/assistant/inbound.ts` | §6 | Inbound email → event → conversation → grounded draft → proposed action |
| `src/api/` | §14, §15 | Fastify API with role-based bearer auth, signed webhooks, minimal dashboard |
| `src/db/` | §3, §5 | Postgres port (node-postgres / PGlite), checksummed migrations, durable event log, outbox and audit |
| `src/identity/` | §4 | Passkeys, device-bound sessions, step-up, device revocation; envelope-encrypted vault (KMS in production) |
| `src/connectors/gmail/` | §6 | Gmail via IMAP IDLE + SMTP (app password): cursor sync, MIME parsing, threading, Sent-Mail reconciliation, drafts, worker |
| `src/voice/realtime.ts` | §8 | Female voice candidates, auditions, ephemeral realtime sessions with persona and tools |
| `src/missions/` | §12, §16 | Missions: always-on agents with goals, schedules, per-action autonomy, read-only background research, activity log, results |
| `src/core/agentLoop.ts` | §12 | Bounded tool-calling loop (OpenAI Responses API) with budgets |
| `src/api/pwa.ts` | §14 | Installable app shell: manifest, service worker (never caches API data), icons |
| `src/setup/`, `config/inventory.json` | §2 | Device and account inventory and blockers (iPhone 17 Pro Max, AT&T) |
| `db/migrations/` | §15 | PostgreSQL + pgvector schema for all required entities, with row-level security |
| `deploy/terraform/`, `Dockerfile` | §3 | Staging and production on Cloud Run + Cloud SQL, KMS, Secret Manager, keyless deploys |
| `test/acceptance/` | §20 | Scenarios A–K |

## Architecture notes

- **Single modular service** (spec §3). The composition root is `src/app.ts`. `createDurableJennifer` runs migrations and persists events, audit, authority rules, contacts and the action outbox to Postgres. The `executing` record is flushed **before** any provider call, so a crash mid-send is reconciled rather than resent. Conversations and memory are still in-memory; they move to Postgres with their connectors (Weeks 3–5).
- **Model provider adapter** (`src/core/model.ts`). It uses the OpenAI Responses API with `store: false`. Model IDs come from configuration. Tests use a scripted model.
- **Untrusted content** is wrapped with randomized delimiters and flagged. Safety does **not** depend on detection: the executor enforces permissions no matter what the model outputs. Scenario E runs with a deliberately compromised model.
- **Time**: events store UTC instants plus the IANA zone and the original local time. Rome routines use `Europe/Rome` wherever the device is.

## Security

- Third-party material (adapted from OpenJarvis, Apache-2.0) is listed in `THIRD_PARTY_LICENSES`.

- Refresh tokens belong in a managed vault (`account_connection.vault_secret_ref`). They never go into prompts, logs or clients.
- Audit details and model-provider errors pass through `redactSecrets`.
- Sign-in uses passkeys with user verification. Sessions are device-bound, stored as hashes and last 12 h. High-risk approvals need a passkey step-up within the last 5 minutes. Revoking a device kills its sessions and passkeys. The static `JENNIFER_API_TOKEN` is a bootstrap/break-glass path and can never satisfy step-up.
- Roles: `owner`, `developer`, `operator`. Non-owner roles see connection health and redacted audit metadata only. The Postgres schema adds row-level security on messages, memory and calls.
- Webhooks: HMAC-SHA256 over `timestamp.body` with a 5-minute tolerance. Provider-specific verifiers (Pub/Sub JWT, Graph `clientState`, Twilio signatures) go in their adapters.

## Deployment prerequisites (not legal advice)

Before live operation: privacy and communications review for Italy, the US and any other operating jurisdiction (recording, automated calling, data handling); Google restricted-scope verification; carrier and sender registration; vendor retention and residency confirmation per endpoint.
