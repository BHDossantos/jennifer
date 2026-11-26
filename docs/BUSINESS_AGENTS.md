# Business agents

One lead agent per business, on top of the seven department agents each company already has. Source of truth: `src/company/businessAgents.ts`. Each task runs as a department shift (WF-05) with a business-specific focus, so it uses the same executor, budgets, citations and approvals as the rest of Company OS.

Each business also has a daily Claude routine on Bruno's Claude account that does the hands-on web work. The business agent does not repeat it: it qualifies and follows up on what lands in the CRM and the brain, and hands hands-on steps back to the routine as Claude tasks that wait for Bruno.

## Approval points every agent shares

- Nothing is sent, posted, published or booked without Bruno approving the exact payload.
- No money is spent: ad ideas and paid options are proposals only.
- CRM changes are proposed patches until Bruno applies them.
- Hands-on work for the Claude routine is a Claude task that waits for Bruno in Tasks.
- Prices, discounts, contracts and anything legal or medical escalate to Bruno.

## API

- `GET /v1/business-agents`: every charter
- `GET /v1/companies/:cid/business-agent`: one charter with each task's last run
- `POST /v1/companies/:cid/business-agent/tasks/:task/run`: run one task now (202, a WF-05 run)
- Chat and voice tool `business_agent_task`: list a business's tasks, or run one

## Insurance agent (`insurance`)

Win and keep small trades businesses in Massachusetts and New Hampshire as business insurance clients.

Works alongside the Claude routine **insurance Business**: Daily commercial-auto renewal campaign pack and up to five new qualified prospects, all in draft.

Rules: Lines: general liability, workers’ comp, commercial auto. Territories: MA and NH only. Never promise savings or quote a price; quotes come from carriers through Bruno. Keep everything in draft while the sending hold is in place; the brand name and domain wait for Bruno’s confirmation. Outreach batches: at most 12 a day, one recipient per message, never CC or BCC.

Measures: qualified prospects (first touch and follow-up counted apart), renewal-review requests, qualified quote requests.

| Task | Run by | When | Reads | Delivers | Waits for Bruno |
|---|---|---|---|---|---|
| Qualify trades prospects (`prospects`) | Sales agent | daily | icp, offer, CRM accounts and contacts, suppression list | CRM tasks per prospect, first-touch drafts in EN, ES or PT | Each draft and each CRM change waits for Bruno. |
| Commercial auto renewal campaign (`renewals`) | Marketing agent | weekly | offer, claims, brand, audience | weekly campaign draft, follow-up drafts | The campaign stays in draft; Bruno approves each send. |
| Answer quote and certificate requests (`replies`) | Customer agent | on reply | procedures, faq, connected inbox | reply drafts, CRM tasks | Replies wait for Bruno; anything about price or coverage escalates. |
| Licensing and opt-out check (`compliance`) | Back office agent | weekly | compliance, policies | compliance report, questions for Bruno | Report only; Bruno decides on any change. |

## B&B Global Services agent (`technology`)

Turn mid-market teams with a cloud, SRE, FinOps or AI delivery need into assessments and contracts.

Works alongside the Claude routine **B&B global services**: Daily campaign pack and up to five new qualified prospects matched to one verified offer.

Rules: Match each prospect to one verified offer, such as the Technology Health Check or the AI Readiness Assessment. Peer-to-peer tone; cite the public signal that makes the prospect a fit.

Measures: qualified replies, assessment bookings, proposals sent, contracts won.

| Task | Run by | When | Reads | Delivers | Waits for Bruno |
|---|---|---|---|---|---|
| Qualify mid-market prospects (`prospects`) | Sales agent | daily | icp, offer, CRM accounts | CRM tasks, email and LinkedIn drafts | Drafts and CRM changes wait for Bruno. |
| Move open deals (`deals`) | Deals agent | daily | offer, pricing, contracts, CRM opportunities | proposal outlines, follow-up drafts | Pricing and terms escalate; proposals wait for Bruno. |
| LinkedIn content week (`content`) | Marketing agent | weekly | offer, brand, claims | post drafts | Each post waits for Bruno before it is scheduled. |

## LearnNoelia agent (`learnnoelia`)

Grow real usage of LearnNoelia with adult learners and individual teachers before any school sale.

Works alongside the Claude routine **learn Noelia**: Daily campaign pack and up to five new qualified prospects among teachers and tutors.

Rules: Adult and public online users first; no school pilots for now. Describe only what the platform does today; no claims about features or results that are not in the approved brain.

Measures: signups, demo interest, active learners, teacher time saved (once measured).

| Task | Run by | When | Reads | Delivers | Waits for Bruno |
|---|---|---|---|---|---|
| Qualify teachers and tutors (`prospects`) | Sales agent | daily | icp, offer, CRM contacts | teacher email and short DM drafts, CRM tasks | Drafts and CRM changes wait for Bruno. |
| Learner content week (`content`) | Marketing agent | weekly | offer, brand, claims, audience | post drafts | Each post waits for Bruno. |
| Learner and teacher feedback (`feedback`) | Customer agent | weekly | faq, procedures, connected inbox | feedback summary, follow-up drafts | Follow-ups wait for Bruno. |

## SavoryMind agent (`restaurant`)

Get independent restaurant owners and managers into conversations, demos and pilots.

Works alongside the Claude routine **savoryMind**: Daily 30-day campaign task and up to five new qualified restaurant contacts.

Rules: Mark hypotheses as hypotheses; no invented customers, metrics or testimonials. No mobile launch, features or results unless the approved brain confirms them.

Measures: qualified replies, conversations booked, demos held, pilots started.

| Task | Run by | When | Reads | Delivers | Waits for Bruno |
|---|---|---|---|---|---|
| Qualify restaurant contacts (`prospects`) | Sales agent | daily | icp, offer, CRM accounts | email and LinkedIn drafts, CRM tasks | Drafts and CRM changes wait for Bruno. |
| Demos and pilots (`demos`) | Deals agent | daily | offer, pricing, CRM opportunities | follow-up drafts, demo script | Calendar holds and messages wait for Bruno. |
| Restaurant content week (`content`) | Marketing agent | weekly | offer, brand, claims | post drafts, demo script | Each post waits for Bruno. |

## Lovera agent (`dating`)

Find Lovera’s first couples and partners and turn interest into signups or waitlist entries.

Works alongside the Claude routine **Lovera**: Daily campaign pack and up to five new qualified early users or partners.

Rules: No mobile release claims unless the approved brain confirms one. One early-user or partner segment at a time, with a call to action that works today.

Measures: qualified replies, signups or waitlist entries, partner conversations.

| Task | Run by | When | Reads | Delivers | Waits for Bruno |
|---|---|---|---|---|---|
| Qualify partners and early users (`partners`) | Sales agent | daily | icp, offer, CRM contacts | partner outreach drafts, CRM tasks | Drafts and CRM changes wait for Bruno. |
| Couples content week (`content`) | Marketing agent | weekly | offer, brand, claims, audience | post drafts | Each post waits for Bruno. |
| Signup follow-up (`signups`) | Customer agent | weekly | faq, procedures | follow-up drafts | Messages wait for Bruno. |

## Bruno D agent (`music`)

Grow listeners and followers for Bruno D’s Brazilian-American R&B and saxophone music.

Works alongside the Claude routine **Bruno D**: Daily campaign pack with Reel hooks and up to five new curators, blogs or collaborators.

Rules: Pitch only through verified channels. Keep public metrics apart from Spotify for Artists data.

Measures: qualified curator replies, listens, saves, follows.

| Task | Run by | When | Reads | Delivers | Waits for Bruno |
|---|---|---|---|---|---|
| Curator and collaborator pitches (`pitches`) | Sales agent | daily | brand, offer, CRM contacts | pitch drafts, CRM tasks | Pitches wait for Bruno. |
| Reels and release content (`content`) | Marketing agent | weekly | brand, campaigns, claims | post drafts, Reel hooks | Each post waits for Bruno before it is scheduled. |
| What is working (`numbers`) | Intelligence agent | weekly | market, campaigns | weekly numbers report | Report only. |

## Foundation agent (`foundation`)

Find scholarship sponsors and program partners for youth education, music and digital literacy, and prepare the Rome benefit.

Works alongside the Claude routine **Esposito–Dossantos Foundation**: Daily campaign pack and up to five new qualified sponsors or partners in Italy, Spain, Portugal or the U.S.

Rules: Use only verified activities and impact. Mention the benefit date only when the approved brain confirms it. Scholarship sponsor asks and program partner asks stay distinct.

Measures: sponsor conversations, qualified sponsorship interest, partner commitments, benefit RSVPs.

| Task | Run by | When | Reads | Delivers | Waits for Bruno |
|---|---|---|---|---|---|
| Qualify sponsors and partners (`sponsors`) | Sales agent | daily | offer, icp, CRM accounts | sponsor and partner ask drafts, CRM tasks | Asks wait for Bruno. |
| Rome benefit preparation (`benefit`) | Operations agent | weekly | procedures, suppliers, CRM tasks | checklist, CRM tasks | Bookings, invitations and payments wait for Bruno. |
| Donor and sponsor follow-up (`donors`) | Customer agent | weekly | brand, procedures | thank-you drafts | Messages wait for Bruno. |

## United Youth Orchestra agent (`nonprofit`)

Keep the orchestra and teen program with the Vatican sisters organized, and support it through the Foundation.

Rules: Never share details about minors; logistics only. Program and partner details only from the approved brain.

Measures: rehearsals held, partner commitments.

| Task | Run by | When | Reads | Delivers | Waits for Bruno |
|---|---|---|---|---|---|
| Program logistics (`program`) | Operations agent | weekly | procedures, suppliers | checklist, CRM tasks | Anything that books, invites or pays waits for Bruno. |
| Partner follow-up (`partners`) | Customer agent | weekly | brand, procedures | update drafts | Messages wait for Bruno. |
