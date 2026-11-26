/** Isolated design map and fixture-only routing preview. Not registered at runtime. */
const routes = Object.freeze({
  technology: Object.freeze({ agent: "Prospect Research", trigger: "Manual review of buying signals", inputs: "Public evidence and a deduplicated company key", output: "Evidence brief and draft outreach only", humanApproval: "Company owner verifies relevance and sends separately", successMeasure: "Qualified discovery calls per prospect reviewed" }),
  insurance: Object.freeze({ agent: "Lead Qualification", trigger: "Manual review of fresh quote intent", inputs: "Consent status, approved operating territory and requested product line", output: "De-identified lead disposition and follow-up draft", humanApproval: "Licensed human reviews eligibility, contact and any quote", successMeasure: "Fresh qualified quote requests by territory and product" }),
  dating: Object.freeze({ agent: "Product Readiness", trigger: "Manual gate after a cohort rehearsal", inputs: "Opt-in cohort aggregates and synthetic onboarding, reporting and matching outcomes", output: "Release blocker and cohort readiness brief", humanApproval: "Product owner approves invitations and rollout", successMeasure: "Completed profiles and reciprocal conversations per cohort" }),
  music: Object.freeze({ agent: "Audience Analytics", trigger: "Manual review of the reporting window", inputs: "Aggregate save, repeat-listener and clip retention data", output: "Track and existing-clip test brief", humanApproval: "Artist approves rights, claims and publication", successMeasure: "Repeat-listener rate and track saves" }),
  foundation: Object.freeze({ agent: "Campaign Strategy", trigger: "Manual review before a campaign test", inputs: "Verified impact goal and consented creative, no donor detail", output: "Campaign variants and measurement brief", humanApproval: "Foundation owner verifies impact claims, rights and publication", successMeasure: "Donor conversion and recurring gifts, separate from sales" }),
  education: Object.freeze({ agent: "Learning Product QA", trigger: "Manual review after an adult learner rehearsal", inputs: "Synthetic or aggregate lesson and quiz results, no school or student records", output: "Readiness report and adult pilot recommendation", humanApproval: "Product owner approves pilot communications; institution rollout is separate", successMeasure: "Independent lesson completion and repeat use" }),
  hospitality: Object.freeze({ agent: "Booking Product QA", trigger: "Manual review of host-confirmed booking rehearsal", inputs: "Synthetic request, confirm, reschedule, cancel, seat and no-show cases", output: "Booking integrity report and pilot recommendation", humanApproval: "Product owner and venue verify each booking outside this tool", successMeasure: "Confirmed booking rate; seated parties counted separately" }),
});

export const reviewRoutes = routes;

type RouteId = keyof typeof routes;
type Preview =
  | { state: 'blocked'; reason: 'invalid-fixture' | 'unknown-route' }
  | { state: 'needs-human-review'; routeId: RouteId; fixtureId: string; route: (typeof routes)[RouteId]; externalAction: false };

export function previewBusinessReview(input: unknown): Preview {
  // Accept only synthetic IDs, not business data, contacts or executable instructions.
  if (typeof input !== 'string' || input.length > 100)
    return { state: 'blocked', reason: 'invalid-fixture' };
  const match = /^([a-z]+):fixture:([a-z0-9][a-z0-9-]{0,63})$/u.exec(input);
  if (!match || match[0] !== input)
    return { state: 'blocked', reason: 'invalid-fixture' };
  const routeId = match[1] as RouteId;
  if (!Object.hasOwn(routes, routeId))
    return { state: 'blocked', reason: 'unknown-route' };
  return { state: 'needs-human-review', routeId, fixtureId: `fixture:${match[2]}`, route: routes[routeId], externalAction: false };
}
