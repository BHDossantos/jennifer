# Backend-only release — November 6, 2026

Release target: existing Render service srv-db1tk2jncjis73cab5f0, workspace
tea-d7kcg11f9bms73abkdlg, configured branch claude/new-session-ruep5f, auto-deploy off.
Current live before release: dep-db4est67bikc73egrbgg,
commit7ca18d598014e97cc60ed547bfd0baa09fb7e225.

This extracts PR13's backend dependency fixes and session-bound native push/logout
work without mobile files or mobile workflows. EAS production automation filters
on mobile/**, so this backend-only change does not trigger store distribution.
Existing PR13 and mobile dependency PR15 remain separate review work.

Reviewed live-to-default differences include authenticated voice/speak (request-only,
existing budget guard), department-agent APIs/UI, registered workflow roles and
new scheduled department shifts. Shifts now require explicit boolean enabled=true;
missing or malformed profiles remain off, preserving existing explicit selections.
This prevents an upgrade from silently starting new model work every six hours.
Other existing schedules are unchanged. Push receipt polling has no external work
without pending receipts; native send requires a registered active device.

No db/migrations files differ from the running version, no schema migrations were
added or edited, and no secrets/configuration/provider accounts are changed.
Native registration adds settings data; rollback to the prior backend ignores
those keys but removes the new endpoints, so do not distribute mobile releases
until backend/device validation is complete. Existing bearer revocation remains
first on logout and native cleanup remains best effort.

Before trigger, verify merged branch SHA matches reviewed source and service still
has autoDeploy off. Capture resulting deploy ID, monitor to live and verify health
and unauthenticated endpoint rejection without creating sessions or notifications.
Authenticated paired-device/APNs/FCM checks remain a separate release gate.
