# Manual private-preparation rehearsal

Run from a local checkout:

```sh
npm ci
npm run typecheck
npm run build
node dist/src/simulator/private-pilot.js
npm test -- --run test/private-pilot.test.ts
```

A disposable in-memory CompanyRepo contains one synthetic CRM account and one
approved evidence reference. Six deterministic role profiles produce private
review packets: coordinator, research, qualification, communications, proposals,
and operations. Qualification requires a reviewed research packet for the same
exact record and version; communications and proposals require reviewed
qualification. Supplier routing is never treated as buyer demand.

Only fixture IDs, one existing technology scope, and reserved example addresses
are accepted. Tasks cannot enable tools or external actions. Review binds the
named fixture reviewer to the exact scoped artifact and recipient, hash, version,
and expiry. A review is not permission to send. The pilot rereads and checks
records/evidence before recording private approval, and rechecks contact holds.
Activity, budget and capacity are limited inside one simulator process. Separate
runs share no state; UTC weekdays are used here only for reproducible examples.

The rehearsal does not invoke an LLM, a provider, the API server, a persistent
ledger, or any existing scheduler. It doesn't prove production authorization,
live data correctness, communication delivery, or real human review economics.
Keep live activation separate. The operator must first reconcile canonical records
and review routing, and separately authorize each new live access or action.
