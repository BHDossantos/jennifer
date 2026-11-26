# Seven-business routing review — design only

The fixture map in [business-review-map.ts](../src/pilot/business-review-map.ts) lists the manual trigger, permitted input categories, proposed agent, review output, human approval and success measure for each of seven verticals. These are proposed responsibilities, not provisioned agents or enabled capabilities. Inputs listed in the map describe a future review, not accepted payloads.

The only implementation here is a deterministic preview on an opaque synthetic key such as `technology:fixture:sample`. A known route resolves to `needs-human-review` and `externalAction: false`; malformed or unknown inputs block. No execution or approval can be granted by the preview. There are no network calls, schedulers, connectors, database writes, API endpoints, live integrations, or changes to model tool access.

Jennifer's Company OS catalog and implemented role versions remain the authority for active capabilities. Its existing technology-only private-preparation pilot remains unchanged. If a later phase is approved, start with an authorized tenant-specific source list, owner/version bindings, current evidence, and existing controls before considering any runtime integration. Consent, publication, financial, and regulated actions remain outside this slice.
