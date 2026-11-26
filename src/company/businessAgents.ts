import type { Department } from './catalog.js';
import { DEPARTMENT_AGENTS } from './departments.js';
import type { CompanyId } from './model.js';

/**
 * Business agents: one lead agent per business, on top of the seven
 * department agents every company already has.
 *
 * A business agent is a charter, not a new model path. Each of its tasks is
 * run as a department shift (WF-05) with a business-specific focus, so every
 * output goes through the same executor, budgets, citations and approvals as
 * the rest of Company OS. The agent proposes; Bruno decides.
 *
 * Each business also has a daily Claude routine on Bruno's own Claude account
 * that does the hands-on web work (finding prospects, drafting campaign packs).
 * The business agent does not repeat that work: it qualifies and follows up on
 * what lands in the CRM and the brain, and hands any hands-on step back to the
 * routine as a Claude task (`delegate_task`) that waits for Bruno's OK.
 */

export type Cadence = 'daily' | 'weekly' | 'on_reply' | 'on_request';

export interface BusinessTask {
  id: string;
  name: string;
  /** The department agent that carries the task out. */
  department: Department;
  cadence: Cadence;
  /** What the agent does on this task. Sent to the shift as its focus. */
  does: string;
  /** What it reads: approved brain categories and connected sources. */
  inputs: string[];
  /** What lands in front of Bruno. */
  outputs: string[];
  /** The point where the work stops and waits for Bruno. */
  approval: string;
}

export interface BusinessAgent {
  companyId: CompanyId;
  name: string;
  mission: string;
  tasks: BusinessTask[];
  /** Business-specific rules, added to every task's focus. */
  guardrails: string[];
  /** The daily Claude routine this agent works alongside (by its name on Bruno's account). */
  routine?: { name: string; does: string };
  /** What each business measures, so the brief and the agents use the same numbers. */
  measures: string[];
}

/** Approval points every business agent shares (enforced by the executor, not by these words). */
export const SHARED_APPROVALS = [
  'Nothing is sent, posted, published or booked without Bruno approving the exact payload.',
  'No money is spent: ad ideas and paid options are proposals only.',
  'CRM changes are proposed patches until Bruno applies them.',
  'Hands-on work for the Claude routine is a Claude task that waits for Bruno in Tasks.',
  'Prices, discounts, contracts and anything legal or medical escalate to Bruno.',
];

const PROSPECTS_HANDOFF = 'The daily Claude routine finds and drafts; this task qualifies what it logged, drops duplicates and anyone on the do-not-contact list, and proposes the next step for each.';

export const BUSINESS_AGENTS: Record<CompanyId, BusinessAgent> = {
  insurance: {
    companyId: 'insurance',
    name: 'Insurance agent',
    mission: 'Win and keep small trades businesses in Massachusetts and New Hampshire as business insurance clients.',
    routine: { name: 'insurance Business', does: 'Daily commercial-auto renewal campaign pack and up to five new qualified prospects, all in draft.' },
    guardrails: [
      'Lines: general liability, workers’ comp, commercial auto. Territories: MA and NH only.',
      'Never promise savings or quote a price; quotes come from carriers through Bruno.',
      'Keep everything in draft while the sending hold is in place; the brand name and domain wait for Bruno’s confirmation.',
      'Outreach batches: at most 12 a day, one recipient per message, never CC or BCC.',
    ],
    measures: ['qualified prospects (first touch and follow-up counted apart)', 'renewal-review requests', 'qualified quote requests'],
    tasks: [
      { id: 'prospects', name: 'Qualify trades prospects', department: 'sales', cadence: 'daily', does: `Qualify painting, cleaning and construction businesses in MA and NH. ${PROSPECTS_HANDOFF}`, inputs: ['icp', 'offer', 'CRM accounts and contacts', 'suppression list'], outputs: ['CRM tasks per prospect', 'first-touch drafts in EN, ES or PT'], approval: 'Each draft and each CRM change waits for Bruno.' },
      { id: 'renewals', name: 'Commercial auto renewal campaign', department: 'marketing', cadence: 'weekly', does: 'Plan the week of the commercial-auto renewal campaign for the eligible first-party audience: offer, call to action and follow-ups. Lead with certificate-of-insurance turnaround.', inputs: ['offer', 'claims', 'brand', 'audience'], outputs: ['weekly campaign draft', 'follow-up drafts'], approval: 'The campaign stays in draft; Bruno approves each send.' },
      { id: 'replies', name: 'Answer quote and certificate requests', department: 'customer', cadence: 'on_reply', does: 'Triage replies: certificate requests, quote questions, renewals and opt-outs. Draft the answer and the next step; opt-outs are suppressed first.', inputs: ['procedures', 'faq', 'connected inbox'], outputs: ['reply drafts', 'CRM tasks'], approval: 'Replies wait for Bruno; anything about price or coverage escalates.' },
      { id: 'compliance', name: 'Licensing and opt-out check', department: 'back_office', cadence: 'weekly', does: 'Check outreach copy and lists against the licensing wording, broker-referral wording and opt-out requirements on file, and list anything that is missing.', inputs: ['compliance', 'policies'], outputs: ['compliance report', 'questions for Bruno'], approval: 'Report only; Bruno decides on any change.' },
    ],
  },
  technology: {
    companyId: 'technology',
    name: 'B&B Global Services agent',
    mission: 'Turn mid-market teams with a cloud, SRE, FinOps or AI delivery need into assessments and contracts.',
    routine: { name: 'B&B global services', does: 'Daily campaign pack and up to five new qualified prospects matched to one verified offer.' },
    guardrails: [
      'Match each prospect to one verified offer, such as the Technology Health Check or the AI Readiness Assessment.',
      'Peer-to-peer tone; cite the public signal that makes the prospect a fit.',
    ],
    measures: ['qualified replies', 'assessment bookings', 'proposals sent', 'contracts won'],
    tasks: [
      { id: 'prospects', name: 'Qualify mid-market prospects', department: 'sales', cadence: 'daily', does: `Qualify teams with a documented cloud, SRE, FinOps or AI delivery signal. ${PROSPECTS_HANDOFF}`, inputs: ['icp', 'offer', 'CRM accounts'], outputs: ['CRM tasks', 'email and LinkedIn drafts'], approval: 'Drafts and CRM changes wait for Bruno.' },
      { id: 'deals', name: 'Move open deals', department: 'deals', cadence: 'daily', does: 'Review open opportunities: next step, proposal or scope questions, stalled deals and follow-ups due.', inputs: ['offer', 'pricing', 'contracts', 'CRM opportunities'], outputs: ['proposal outlines', 'follow-up drafts'], approval: 'Pricing and terms escalate; proposals wait for Bruno.' },
      { id: 'content', name: 'LinkedIn content week', department: 'marketing', cadence: 'weekly', does: 'Plan the week of LinkedIn posts for the company page from the approved offers and case material.', inputs: ['offer', 'brand', 'claims'], outputs: ['post drafts'], approval: 'Each post waits for Bruno before it is scheduled.' },
    ],
  },
  learnnoelia: {
    companyId: 'learnnoelia',
    name: 'LearnNoelia agent',
    mission: 'Grow real usage of LearnNoelia with adult learners and individual teachers before any school sale.',
    routine: { name: 'learn Noelia', does: 'Daily campaign pack and up to five new qualified prospects among teachers and tutors.' },
    guardrails: [
      'Adult and public online users first; no school pilots for now.',
      'Describe only what the platform does today; no claims about features or results that are not in the approved brain.',
    ],
    measures: ['signups', 'demo interest', 'active learners', 'teacher time saved (once measured)'],
    tasks: [
      { id: 'prospects', name: 'Qualify teachers and tutors', department: 'sales', cadence: 'daily', does: `Qualify individual language teachers and tutors. ${PROSPECTS_HANDOFF}`, inputs: ['icp', 'offer', 'CRM contacts'], outputs: ['teacher email and short DM drafts', 'CRM tasks'], approval: 'Drafts and CRM changes wait for Bruno.' },
      { id: 'content', name: 'Learner content week', department: 'marketing', cadence: 'weekly', does: 'Plan the week of posts aimed at adult learners, with one clear call to action the site supports today.', inputs: ['offer', 'brand', 'claims', 'audience'], outputs: ['post drafts'], approval: 'Each post waits for Bruno.' },
      { id: 'feedback', name: 'Learner and teacher feedback', department: 'customer', cadence: 'weekly', does: 'Summarize feedback and support questions, and propose follow-ups for new signups.', inputs: ['faq', 'procedures', 'connected inbox'], outputs: ['feedback summary', 'follow-up drafts'], approval: 'Follow-ups wait for Bruno.' },
    ],
  },
  restaurant: {
    companyId: 'restaurant',
    name: 'SavoryMind agent',
    mission: 'Get independent restaurant owners and managers into conversations, demos and pilots.',
    routine: { name: 'savoryMind', does: 'Daily 30-day campaign task and up to five new qualified restaurant contacts.' },
    guardrails: [
      'Mark hypotheses as hypotheses; no invented customers, metrics or testimonials.',
      'No mobile launch, features or results unless the approved brain confirms them.',
    ],
    measures: ['qualified replies', 'conversations booked', 'demos held', 'pilots started'],
    tasks: [
      { id: 'prospects', name: 'Qualify restaurant contacts', department: 'sales', cadence: 'daily', does: `Qualify independent restaurant owners and managers. ${PROSPECTS_HANDOFF}`, inputs: ['icp', 'offer', 'CRM accounts'], outputs: ['email and LinkedIn drafts', 'CRM tasks'], approval: 'Drafts and CRM changes wait for Bruno.' },
      { id: 'demos', name: 'Demos and pilots', department: 'deals', cadence: 'daily', does: 'Follow up on conversations: propose demo times, a short workflow call or a pilot, and flag what would make the restaurant say yes.', inputs: ['offer', 'pricing', 'CRM opportunities'], outputs: ['follow-up drafts', 'demo script'], approval: 'Calendar holds and messages wait for Bruno.' },
      { id: 'content', name: 'Restaurant content week', department: 'marketing', cadence: 'weekly', does: 'Plan the week of posts and a 30-second demo script from the approved offer.', inputs: ['offer', 'brand', 'claims'], outputs: ['post drafts', 'demo script'], approval: 'Each post waits for Bruno.' },
    ],
  },
  dating: {
    companyId: 'dating',
    name: 'Lovera agent',
    mission: 'Find Lovera’s first couples and partners and turn interest into signups or waitlist entries.',
    routine: { name: 'Lovera', does: 'Daily campaign pack and up to five new qualified early users or partners.' },
    guardrails: ['No mobile release claims unless the approved brain confirms one.', 'One early-user or partner segment at a time, with a call to action that works today.'],
    measures: ['qualified replies', 'signups or waitlist entries', 'partner conversations'],
    tasks: [
      { id: 'partners', name: 'Qualify partners and early users', department: 'sales', cadence: 'daily', does: `Qualify partners and early-user groups for the chosen segment. ${PROSPECTS_HANDOFF}`, inputs: ['icp', 'offer', 'CRM contacts'], outputs: ['partner outreach drafts', 'CRM tasks'], approval: 'Drafts and CRM changes wait for Bruno.' },
      { id: 'content', name: 'Couples content week', department: 'marketing', cadence: 'weekly', does: 'Plan the week of posts for the chosen segment, each with the working call to action.', inputs: ['offer', 'brand', 'claims', 'audience'], outputs: ['post drafts'], approval: 'Each post waits for Bruno.' },
      { id: 'signups', name: 'Signup follow-up', department: 'customer', cadence: 'weekly', does: 'Review new signups and waitlist entries and propose a welcome or follow-up message.', inputs: ['faq', 'procedures'], outputs: ['follow-up drafts'], approval: 'Messages wait for Bruno.' },
    ],
  },
  music: {
    companyId: 'music',
    name: 'Bruno D agent',
    mission: 'Grow listeners and followers for Bruno D’s Brazilian-American R&B and saxophone music.',
    routine: { name: 'Bruno D', does: 'Daily campaign pack with Reel hooks and up to five new curators, blogs or collaborators.' },
    guardrails: ['Pitch only through verified channels.', 'Keep public metrics apart from Spotify for Artists data.'],
    measures: ['qualified curator replies', 'listens', 'saves', 'follows'],
    tasks: [
      { id: 'pitches', name: 'Curator and collaborator pitches', department: 'sales', cadence: 'daily', does: `Qualify playlist curators, music blogs and collaborators. ${PROSPECTS_HANDOFF}`, inputs: ['brand', 'offer', 'CRM contacts'], outputs: ['pitch drafts', 'CRM tasks'], approval: 'Pitches wait for Bruno.' },
      { id: 'content', name: 'Reels and release content', department: 'marketing', cadence: 'weekly', does: 'Plan the week of Reels and posts around the current release, with three hooks to test.', inputs: ['brand', 'campaigns', 'claims'], outputs: ['post drafts', 'Reel hooks'], approval: 'Each post waits for Bruno before it is scheduled.' },
      { id: 'numbers', name: 'What is working', department: 'intelligence', cadence: 'weekly', does: 'Compare the week’s public numbers and say which hooks, songs and posts to keep or drop.', inputs: ['market', 'campaigns'], outputs: ['weekly numbers report'], approval: 'Report only.' },
    ],
  },
  foundation: {
    companyId: 'foundation',
    name: 'Foundation agent',
    mission: 'Find scholarship sponsors and program partners for youth education, music and digital literacy, and prepare the Rome benefit.',
    routine: { name: 'Esposito–Dossantos Foundation', does: 'Daily campaign pack and up to five new qualified sponsors or partners in Italy, Spain, Portugal or the U.S.' },
    guardrails: ['Use only verified activities and impact.', 'Mention the benefit date only when the approved brain confirms it.', 'Scholarship sponsor asks and program partner asks stay distinct.'],
    measures: ['sponsor conversations', 'qualified sponsorship interest', 'partner commitments', 'benefit RSVPs'],
    tasks: [
      { id: 'sponsors', name: 'Qualify sponsors and partners', department: 'sales', cadence: 'daily', does: `Qualify scholarship sponsors and program partners. ${PROSPECTS_HANDOFF}`, inputs: ['offer', 'icp', 'CRM accounts'], outputs: ['sponsor and partner ask drafts', 'CRM tasks'], approval: 'Asks wait for Bruno.' },
      { id: 'benefit', name: 'Rome benefit preparation', department: 'operations', cadence: 'weekly', does: 'List what the Rome benefit still needs: venue items, program, guests, sponsors and deadlines, with owners.', inputs: ['procedures', 'suppliers', 'CRM tasks'], outputs: ['checklist', 'CRM tasks'], approval: 'Bookings, invitations and payments wait for Bruno.' },
      { id: 'donors', name: 'Donor and sponsor follow-up', department: 'customer', cadence: 'weekly', does: 'Propose thank-yous and updates for sponsors and donors who engaged this week.', inputs: ['brand', 'procedures'], outputs: ['thank-you drafts'], approval: 'Messages wait for Bruno.' },
    ],
  },
  nonprofit: {
    companyId: 'nonprofit',
    name: 'United Youth Orchestra agent',
    mission: 'Keep the orchestra and teen program with the Vatican sisters organized, and support it through the Foundation.',
    guardrails: ['Never share details about minors; logistics only.', 'Program and partner details only from the approved brain.'],
    measures: ['rehearsals held', 'partner commitments'],
    tasks: [
      { id: 'program', name: 'Program logistics', department: 'operations', cadence: 'weekly', does: 'List open program items: rehearsals, instruments, volunteers and deadlines, with owners.', inputs: ['procedures', 'suppliers'], outputs: ['checklist', 'CRM tasks'], approval: 'Anything that books, invites or pays waits for Bruno.' },
      { id: 'partners', name: 'Partner follow-up', department: 'customer', cadence: 'weekly', does: 'Propose updates and follow-ups for the program’s partners.', inputs: ['brand', 'procedures'], outputs: ['update drafts'], approval: 'Messages wait for Bruno.' },
    ],
  },
};

export function businessAgent(companyId: CompanyId): BusinessAgent {
  return BUSINESS_AGENTS[companyId];
}

export function businessTask(companyId: CompanyId, taskId: string): BusinessTask | undefined {
  return BUSINESS_AGENTS[companyId].tasks.find((t) => t.id === taskId);
}

/** WF-05 takes a focus of at most 500 characters. */
export const FOCUS_MAX = 500;

/** The shift focus for one business task: the task first, then the business rules. */
export function taskFocus(agent: BusinessAgent, task: BusinessTask): string {
  let focus = `${agent.name} · ${task.name}: ${task.does}`;
  for (const g of agent.guardrails) {
    if (focus.length + g.length + 1 > FOCUS_MAX) break;
    focus += ` ${g}`;
  }
  return focus.slice(0, FOCUS_MAX);
}

/** The charter as the API and the app show it. */
export function charterView(agent: BusinessAgent) {
  return {
    ...agent,
    sharedApprovals: SHARED_APPROVALS,
    tasks: agent.tasks.map((t) => ({ ...t, carriedOutBy: DEPARTMENT_AGENTS[t.department].name })),
  };
}
