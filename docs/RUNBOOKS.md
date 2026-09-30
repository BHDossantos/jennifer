# Incident runbooks (spec §21)

Each runbook covers detection, containment, recovery, the owner, and how Bruno is notified.

## Global emergency stop
- **Detect:** Bruno or an operator sees Jennifer doing something wrong.
- **Contain:** `POST /v1/controls/emergency-stop`. All pending actions are canceled and no execution is possible until resumed.
- **Recover:** Review `GET /v1/audit`, fix the rule or workflow, then `POST /v1/controls/resume`.
- **Tell Bruno:** stopping cannot unsend messages that providers already accepted.
- **Owner:** Bruno / engineering lead.

## Leaked token
- **Contain:** Revoke the connector in the provider console and the vault. The connector moves to `disconnected` and sends are refused.
- **Recover:** Rotate the vault secret, re-run OAuth, and check the provider audit logs for use during the exposure window.
- **Owner:** Security reviewer.

## Duplicate or incorrect send
- **Detect:** Audit shows two `action.executed` events for one conversation, or Bruno reports it.
- **Contain:** Pause the connector (`POST /v1/controls/pause {connectorId}`).
- **Recover:** Trace the action history to its rule or approval. Add a regression scenario and correct the rule. Draft an apology for Bruno to approve if needed.
- **Owner:** Engineering lead.

## Provider outage / webhook gap
- **Detect:** The daily brief shows the connector as `stale` or `disconnected`, or the dead-letter queue grows.
- **Recover:** Run history-cursor reconciliation. Renew Gmail watches (≤ 7 days, daily recommended) and Graph subscriptions.
- **Owner:** Engineering lead.

## Failed call transfer
- Jennifer automatically offers message taking and creates a `transfer_failed` follow-up. Check the telephony provider status and the transfer target number.

## Incorrect memory
- Bruno corrects the entry, or deletes it (`DELETE /v1/memory/:id`). Deletion removes the embedding and writes a ledger entry that blocks reimport.

## Bad model release
- `ModelRegistry.rollback()` restores the previous live version. Record an evaluation run explaining the regression.

## Lost phone
- Revoke the device (`device.revoked_at`), rotate that device's credentials, and check recent approvals made from it.

## Database restore
- Target: RPO ≤ 15 min, RTO ≤ 4 h. Restore to staging first, verify audit continuity, then promote. Rehearse this in week 13.
