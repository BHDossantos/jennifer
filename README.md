# Jennifer

Bruno's persistent executive assistant: backend foundation, policy engine, durable action pipeline and local simulator, built from the *Jennifer Virtual Assistant Developer Specification* (v1, 30 Sep 2026).

> **Status:** Weeks 1–2 of the spec's backlog are complete (inventory, operating contract, environments, identity, vault, Postgres persistence), with domain logic for later weeks, all running against a **local simulator**. Jennifer is **not** connected to any of Bruno's real accounts. Real connectors, the mobile app and the realtime voice gateway are adapters still to be built behind the interfaces here. See [`docs/BACKLOG.md`](docs/BACKLOG.md) for what is done and what remains.

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
npm test            # 63 tests incl. acceptance scenarios A–K and Postgres integration (PGlite)
npm run typecheck
npm run simulate    # end-to-end walkthrough against the fake inbox
npm run dev         # API + dashboard on http://localhost:8787, durable (PGlite in .data/ or DATABASE_URL)
```

Node ≥ 20. Copy `.env.example` to `.env` for configuration. In development, the server seeds simulated contacts, a calendar event, standing instructions and an inbound email.

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

- Refresh tokens belong in a managed vault (`account_connection.vault_secret_ref`). They never go into prompts, logs or clients.
- Audit details and model-provider errors pass through `redactSecrets`.
- Sign-in uses passkeys with user verification. Sessions are device-bound, stored as hashes and last 12 h. High-risk approvals need a passkey step-up within the last 5 minutes. Revoking a device kills its sessions and passkeys. The static `JENNIFER_API_TOKEN` is a bootstrap/break-glass path and can never satisfy step-up.
- Roles: `owner`, `developer`, `operator`. Non-owner roles see connection health and redacted audit metadata only. The Postgres schema adds row-level security on messages, memory and calls.
- Webhooks: HMAC-SHA256 over `timestamp.body` with a 5-minute tolerance. Provider-specific verifiers (Pub/Sub JWT, Graph `clientState`, Twilio signatures) go in their adapters.

## Deployment prerequisites (not legal advice)

Before live operation: privacy and communications review for Italy, the US and any other operating jurisdiction (recording, automated calling, data handling); Google restricted-scope verification; carrier and sender registration; vendor retention and residency confirmation per endpoint.
