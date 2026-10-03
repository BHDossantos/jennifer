# Existing code assessment (Week 1)

The spec (§2) says to inspect existing assistant code before reusing it. Reviewed 3 Oct 2026 (read-only, shallow clones).

| Repo | Finding | Reuse |
|---|---|---|
| `BHDossantos/Jarvis` | Empty apart from a placeholder CI workflow | None |
| `BHDossantos/Jarvis-ML` | Empty repository | None |
| `BHDossantos/Bruno-AI-Workforce` | Production FastAPI + Postgres growth/CRM platform: about 120 modules, 52 routers, about 50 tables, 22 scheduled agents, 357 smoke tests in CI | **Yes**: as a connector, plus selected logic and deployment config |

## What Workforce is

It runs outreach for the businesses: Thrust insurance, B&B Global, SavoryMind, music, job hunting, and the foundation. It finds leads, drafts and sends email and SMS, places and records calls (SignalWire through its Twilio-compatible API), transcribes and summarizes them, logs structured outcomes, and emails a daily CEO brief. It deploys to Google Cloud Run + Cloud SQL from GitHub Actions.

## How Jennifer uses it

**Workforce becomes a "business workflows" connector at observe/draft level.**

- **Read** (Jennifer → Workforce REST, using a dedicated low-privilege `viewer` service user): leads, conversation outcomes and insights, scored jobs, music outreach drafts, and the CEO brief. These feed Jennifer's daily priorities, job-opportunity review and music-outreach-drafting workflows.
- **Events:** Jennifer subscribes to Workforce's HMAC-signed webhooks (`lead.replied`, `client.*`) instead of polling.
- **Never send through Workforce.** Anything Jennifer sends goes through her own executor and authority registry.
- **Shared suppression:** import Workforce's `do_not_contact` list into Jennifer's suppression list, so "stop contacting X" holds across both systems.
- **One owner per phone number and mailbox:** Jennifer gets her own SignalWire number (or subproject) and does not drive Workforce's insurance lines.

### Port to TypeScript (logic, not code)

| Item | Source | Jennifer target |
|---|---|---|
| Twilio/SignalWire carrier switch | `backend/app/integrations/telco.py` | telephony adapter (Week 8) |
| Call markup: bridge, inbound forward → voicemail, answering-machine detection, recording consent | `integrations/twilio_voice.py`, `routers/calls.py` | `src/voice/call.ts` transport (Week 8) |
| Recording → transcript → summary flow | `call_intelligence.py` | call summaries (Week 8) |
| Structured outcome → objection → next action, plus weekly learnings | `conversation_engine.py` | feedback learning (Week 12) |
| Business registry | `business_registry.py`, `businesses.py` | Spaces: insurance (Thrust), technology (B&B Global), restaurant (SavoryMind), music, nonprofit (foundation), personal |
| Deploy pipeline and Secret Manager setup | `cloudbuild.backend.yaml`, `.github/workflows/deploy.yml`, `scripts/setup-secrets.sh` | staging/prod (switch to Workload Identity Federation instead of a JSON key) |

Gmail: Workforce **polls** every 5 minutes, using offline-minted tokens or SMTP app passwords. Jennifer builds the spec's watch + history-cursor adapter with a proper OAuth flow instead (Week 3). Workforce's mailbox map tells us which accounts exist.

### Avoid

- `autoapply.py` "aggressive" mode, which breaks LinkedIn/Indeed terms of service.
- Social OAuth refresh (out of scope).
- Outreach autopilot sending without approval.

## Security issues found in Workforce (fix there, independent of Jennifer)

1. **Carrier webhooks are unsigned:** `routers/sms.py`, `routers/calls.py`. Anyone can forge inbound SMS or call-status events. Verify the Twilio/SignalWire signature.
2. **Setup-screen secrets stored in plaintext** in the `settings` table (`runtime_config.py`): OpenAI key, Gmail app passwords, SignalWire token. Encrypt them as the `connections` table already does.
3. **Weak boot defaults:** the encryption key falls back to one derived from `SECRET_KEY`; `SECRET_KEY` / `ADMIN_PASSWORD` default to "change-me" values and the app still boots (`security.py`, `config.py`). Refuse to start in production with defaults.
4. **CORS** reflects any origin with credentials (`main.py`).
5. **Auth** is a single admin login (JWT HS256, 24 h); `/cron/*` and `/bridge/*` use static shared tokens.
6. **Autopilot sends without approval**, and production forces the scheduler on.
7. **Resend webhook** skips verification when no secret is set.

Each issue is a gap Jennifer's design closes. Fix them in Workforce before connecting the two systems.

## Before connecting (owner: Bruno + engineering)

- [ ] Create a `viewer` service user in Workforce for Jennifer (read only)
- [ ] Fix items 1–3 above
- [ ] Decide which Gmail account is Jennifer's primary (personal vs Thrust insurance)
- [ ] Buy a dedicated SignalWire number for Jennifer
- [ ] Register Jennifer's webhook URL in Workforce
