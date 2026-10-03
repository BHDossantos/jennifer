# Operating contract (spec §1)

How Jennifer decides whether she may act. Enforced in code by the authority registry (`src/policy/authority.ts`) and the single executor (`src/actions/service.ts`). A model can propose; it can never grant itself permission.

## The four settings

Each can be set per account, contact, domain, space or workflow.

| Setting | Jennifer may… |
|---|---|
| **Observe** | Read and summarize. No drafts, no actions |
| **Draft** | Prepare drafts. You send |
| **Execute** (standing instruction) | Act without asking, inside the rule's scope and limits |
| **Ask** | Prepare the exact action and wait for your decision on that version |

No rule → **Ask**. When several rules match, the most specific wins (contact > domain > account > space); on a tie, the most restrictive wins.

## Always behind specific authority or a concrete approval

Money transfers · contract signatures · account security changes · mass outreach · disclosure of identity or financial documents.

A standing rule for these must name specific contacts or accounts and carry an expiry; transfers also need a EUR limit. Approving one requires second-factor verification. "Manage everything" never supplies an amount, recipient or terms.

## Approvals

- An approval is bound to one exact version (revision + payload hash) and to you. Editing the text invalidates it.
- Approvals expire (24 h default) and are used once.

## Guarantees (tested)

- Changing or revoking a rule affects queued work immediately; a revoked action cannot run.
- Every send is traceable in the audit log to the rule or approval that authorized it.
- "Stop contacting X" persists across all workflows until you lift it.
- Pause, per-connector pause, per-contact pause and emergency stop cancel queued work. Messages already sent cannot reliably be unsent.

## Templates (off until you enable them)

`routine_scheduling`, `administrative_replies`, `draft_only`, `personal_relationship`, `observe_only`. Enable one at `POST /v1/authority/templates/:id` with a scope (contacts, accounts or domains). See `src/policy/templates.ts`.
