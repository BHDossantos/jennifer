# Jennifer Company OS

Implementation of *Jennifer Company OS — Product, design and engineering blueprint* (v1.0, 30 Sep 2026) inside the Jennifer backend. Jennifer is the coordinator; the departments, roles, company brain, CRM and workflows below run on the same policy engine, approvals, audit trail, cost ceiling and evaluation harness as the personal assistant. Voice and chat reach the same workflows through tools (`company_overview`, `start_company_workflow`), so there is no separate path around the rules (blueprint A04).

## What exists now

| Blueprint item | Status | Where |
|---|---|---|
| Company spaces: Thrust Insurance (pilot), B&B Global Services, Music, SavoryMind, United Youth Orchestra, LearnNoelia, Esposito Dos Santos Foundation, Dating app (renameable) | Built | `src/company/engine.ts` (`DEFAULT_COMPANIES`) |
| F02 Company scope and memberships; generic not-found for other companies | Built (single owner today; membership model ready for team members) | `CompanyOS.access`, `company_membership` |
| F03 137-role registry as design records; 12 pilot roles with versioned, immutable contracts | Built | `src/company/catalog.ts`, `src/company/roles.ts` |
| Honest readiness (ready / needs setup / paused / design only) with exact blockers | Built | `roleStatus()` |
| F04 Company brain: sources → parse → chunk → review → approved; categories; expiry; revocation; permission-first search | Built (text and web pages; PDF/OCR not yet) | `src/company/brain.ts` |
| F05 Persisted runs and ordered events; resume after restart without repeating finished steps; cancellation; SSE with `Last-Event-ID` | Built | `src/company/engine.ts`, `GET …/runs/:id/events` |
| F06 Policy and action ledger, exact-payload approvals, standing grants, idempotency, reconciliation | Built (shared with Jennifer: `src/actions`, `src/policy`) | — |
| P01 Role executor: strict output envelope, timeouts, budgets, refusals/malformed output as explicit failures, citations limited to supplied sources | Built | `src/company/executor.ts` |
| P02 Email connector with incremental sync and dedup | Built (Gmail, iMessage, SMS, WhatsApp) | `src/connectors` |
| P03 WF-01 Prospect → reviewed draft (nothing sent) | Built | `prospectToDraft` |
| P04 WF-02 Reply → next action (opt-out suppression first, sequence pause, CRM patch, meeting brief) | Built | `replyToNextAction` |
| P05 WF-03 Daily executive brief (manual; opt-in schedule per company time zone, one per day) | Built | `dailyBrief`, `tickSchedules` |
| P06 Approval and history UI (exact payloads, CRM diffs, sources, blockers, live run progress) | Built | Company tab (`public/company.js`) |
| P07 Pilot evaluation set ≥100 cases incl. EN/PT/ES/FR/IT and adversarial cases | Built: 112 cases, 0 critical failures | `test/evals/companyCatalog.ts` |
| CRM with versioned patches and conflict detection (D09) | Built | `src/company/crm.ts` |
| Company emergency stop | Built | `POST /v1/companies/:id/status` |
| E01 Controlled sending | Built through Jennifer's approval queue: an approved draft becomes an exact send proposal that waits for Bruno (first contact is never automatic) | `prepare-send` |
| E02 WF-04 Weekly content & social plan (M04 plan, M09 captions, M17 deterministic claim/price/limit check; each post an approval, then Claude schedules it in Metricool; ad ideas are proposals only, no spend; optional Friday auto-plan) | Built | `src/company/marketing.ts` |
| Department agents: one always-on agent per department (sales, deals, marketing, operations, intelligence, customer, back office) per company. Its skills are its department's catalog roles. WF-05 shift every 6 h by default (1–24 h, per company, per department on/off) once the company has approved knowledge: reads the brain, CRM and recent runs, keeps its own notes between shifts, writes a report, files CRM tasks (CRM patches) and Claude tasks (`delegate_task`) for Bruno's OK, drafts text, asks questions. It never sends, posts, spends or changes records by itself | Built | `src/company/departments.ts`, `GET/PUT /v1/companies/:id/agents`, `POST /v1/companies/:id/agents/:dept/run` |
| E03–E04 Dedicated onboarding and support workflows | Covered by the Customer agent's shifts; no separate workflow yet | — |
| A02 Back-office (WF-06 cash scenarios) | Not built yet | — |
| A05 Multi-customer product | Out of scope | — |

## Rules the system enforces

- A role is never shown as active because a prompt exists. 122 of 137 roles are design records until they get an executor, tools, sources and tests.
- Company scope comes from the server (stored conversation, connector account, membership), never from text a model or client supplied.
- Knowledge is used only after the owner approves it; expired or revoked sources disappear from retrieval; roles only see their allowed categories (e.g. a marketing role never sees "participants").
- External text is labeled untrusted; models cannot pick credentials, recipients' authority or approvals.
- WF-01 never guesses an e-mail address: a contact address must be printed on the verified source page and match the company's domain.
- Opt-outs win: the deterministic stop-request check catches them even if the model misclassifies, suppresses the address and cancels queued outreach.
- A pricing or discount question escalates to Bruno; it never becomes authority for a commercial term.
- Nothing in the pilot workflows sends anything. Sending is a separate, exact, approved action (and Jennifer only ever replies on her own).
- Every run has a budget; the executor refuses a step when the budget is spent, and costs are recorded per company and role.

## Launch checklist for Bruno (blueprint §20)

1. Pick the pilot company (default: insurance) — in the app: **Company → Insurance agency (pilot)**.
2. **Brain:** add and approve the offer (category `offer`), the ideal customer profile (`icp`), brand voice (`brand`) and allowed claims (`claims`).
3. Connect the inbox (Gmail is enough) — WF-02 needs it.
4. **Start work → WF-03** to see the first brief; set a daily time in **Settings** if you want it every morning.
5. **Start work → WF-01** with a small batch (≤10); review the drafts, CRM proposals and exclusion reasons.
6. Turn on **auto-triage** in Settings when the WF-02 results look right.
7. Review the first ten complete outputs end to end before widening use.

## Not yet done

- PDF/Word ingestion and OCR for the company brain (text and web pages work today).
- Team members with their own sign-in (the membership model exists; only Bruno can sign in now).
- WF-05 onboarding, WF-06 cash scenarios and the other phase-2/3 roles.
- A dedicated external CRM connector (HubSpot, Pipedrive…): the built-in CRM is the system of record until one is chosen.
- Postgres row-level security policies (company scoping is enforced in every query and tested; RLS would be defense in depth).
