import { z } from 'zod';
import { DateTime } from 'luxon';
import type { Evidence } from './executor.js';
import type { WorkflowDef } from './engine.js';
import type { CompanyId } from './model.js';
import { runRole, type WorkflowDeps } from './workflows.js';

/**
 * WF-04 Weekly content & social plan (blueprint E02, marketing department).
 *
 * M04 plans the week from the company's approved offer, audience, brand
 * voice and allowed claims; M09 writes the captions; a deterministic M17
 * check drops anything with a price, percentage, guarantee or "free" that
 * the approved material does not state, or that breaks a channel's limits.
 * Each surviving post becomes one task for Bruno to approve; once approved,
 * Claude schedules it in Metricool through his routine. Ad ideas are a
 * proposal only: no budget is ever committed by this workflow.
 */
export const CHANNELS = ['instagram', 'facebook', 'linkedin', 'tiktok', 'x'] as const;
const LIMITS: Record<(typeof CHANNELS)[number], number> = { instagram: 2200, facebook: 3000, linkedin: 3000, tiktok: 2200, x: 280 };

const str = { type: 'string' };
const num = { type: 'number' };
const obj = (props: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });

const Plan = z.object({
  theme: z.string(),
  posts: z.array(z.object({ day: z.string(), time: z.string(), channel: z.string(), format: z.string(), idea: z.string(), sourceId: z.string() })),
  adIdeas: z.array(z.object({ platform: z.string(), objective: z.string(), audience: z.string(), dailyBudgetEur: z.number(), headline: z.string(), primaryText: z.string(), sourceId: z.string() })),
});
const Captions = z.object({ captions: z.array(z.object({ index: z.number().int(), caption: z.string(), hashtags: z.array(z.string()), imagePrompt: z.string() })) });

export interface ReadyPost {
  day: string;
  time: string;
  channel: (typeof CHANNELS)[number];
  format: string;
  idea: string;
  caption: string;
  hashtags: string[];
  imagePrompt: string;
}

/** Risky marketing tokens that must appear in the approved material before a post may use them. */
const RISKY = /([$€£]\s?\d[\d.,]*|\d[\d.,]*\s?(?:%|percent|euros?|dollars?|usd|eur)|\bfree\b|\bguarantee[ds]?\b|\bbest\b|\b#?1\b|\bno\.? ?1\b|\bcure[sd]?\b|\brisk[- ]free\b)/gi;

export function checkPost(p: ReadyPost, approvedText: string, weekStart: DateTime, weekEnd: DateTime): string[] {
  const problems: string[] = [];
  const full = `${p.caption} ${p.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ')}`;
  if (!p.caption.trim()) problems.push('empty caption');
  if (full.length > LIMITS[p.channel]) problems.push(`too long for ${p.channel} (${full.length}/${LIMITS[p.channel]})`);
  if (p.hashtags.length > 15) problems.push('more than 15 hashtags');
  const day = DateTime.fromISO(p.day, { zone: weekStart.zone });
  if (!day.isValid || day < weekStart.startOf('day') || day > weekEnd.endOf('day')) problems.push(`date ${p.day} is outside the planned week`);
  if (!/^\d{2}:\d{2}$/.test(p.time)) problems.push(`time ${p.time} is not HH:MM`);
  const approved = approvedText.toLowerCase();
  for (const m of full.match(RISKY) ?? []) if (!approved.includes(m.toLowerCase().trim())) problems.push(`"${m.trim()}" is not in the approved offer or claims`);
  return problems;
}

export function weeklyContent(d: WorkflowDeps & { canSchedule?: () => boolean }): WorkflowDef {
  return {
    id: 'WF-04',
    version: 1,
    name: 'Weekly content & social plan',
    description: 'A week of on-brand posts from the approved offer, audience and claims; each post waits for your OK, then Claude schedules it in Metricool. Ad ideas are proposals only.',
    roles: ['M04', 'M09', 'M17'],
    input: z.object({
      weekOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      channels: z.array(z.enum(CHANNELS)).min(1).max(5).default(['instagram', 'facebook']),
      postsPerWeek: z.number().int().min(1).max(10).default(4),
      language: z.enum(['en', 'pt', 'es', 'fr', 'it']).default('en'),
      includeAdIdeas: z.boolean().default(true),
    }),
    defaultBudgetEur: 1,
    steps: [
      {
        key: 'preflight',
        label: 'Checking approved offer, brand voice and budget',
        run: async (ctx) => {
          const cats = await ctx.brain.approvedCategories(ctx.company.id as CompanyId);
          const blockers: string[] = [];
          if (!cats.has('offer')) blockers.push('Add and approve what the company sells in the company brain (category "offer")');
          if (!cats.has('brand')) blockers.push('Add and approve the brand voice in the company brain (category "brand")');
          if (!ctx.executor.available) blockers.push('Writing posts needs an AI key on the server');
          if (ctx.remainingBudget() < 0.3) blockers.push('Budget too small for a weekly plan (at least €0.30)');
          if (blockers.length) return { status: 'blocked', blockers };
          const tz = ctx.company.timezone;
          const start = ctx.run.input.weekOf
            ? DateTime.fromISO(ctx.run.input.weekOf as string, { zone: tz }).startOf('day')
            : DateTime.fromJSDate(ctx.clock.now(), { zone: tz }).plus({ weeks: 1 }).startOf('week');
          ctx.run.state.weekStart = start.toISODate();
          ctx.run.state.weekEnd = start.plus({ days: 6 }).toISODate();
          const c = ctx.company.id as CompanyId;
          const kb = [...(await ctx.brain.approved(c, ['offer', 'brand', 'claims'], 12)), ...(await ctx.brain.approved(c, ['icp'], 3))];
          ctx.run.state.evidence = kb.map((k) => ({ sourceId: k.sourceId, locator: k.locator, title: k.title, text: k.text, trusted: true }));
          return { status: 'done' };
        },
      },
      {
        key: 'plan',
        roleId: 'M04',
        label: 'Planning the week (themes, channels, days)',
        run: async (ctx) => {
          const i = ctx.run.input as { channels: string[]; postsPerWeek: number; language: string; includeAdIdeas: boolean };
          const task = [
            `Plan ${i.postsPerWeek} social posts for ${ctx.company.name} between ${ctx.run.state.weekStart} and ${ctx.run.state.weekEnd} (${ctx.company.timezone}).`,
            `Channels: ${i.channels.join(', ')}. Language: ${i.language}. Spread them over the week at sensible local times (HH:MM).`,
            'Each post: day (YYYY-MM-DD), time, channel, format (post, carousel, reel or story), a one-sentence idea grounded in the approved material, and the sourceId it relies on.',
            i.includeAdIdeas
              ? 'Also propose up to 2 paid ad ideas (platform, objective, audience, a modest dailyBudgetEur, headline, primaryText). They are proposals only; never state prices or results that are not in the material.'
              : 'Return adIdeas as an empty list.',
          ].join(' ');
          const r = await runRole(ctx, 'M04', task, ctx.run.state.evidence as Evidence[], obj({ theme: str, posts: { type: 'array', items: obj({ day: str, time: str, channel: str, format: str, idea: str, sourceId: str }) }, adIdeas: { type: 'array', items: obj({ platform: str, objective: str, audience: str, dailyBudgetEur: num, headline: str, primaryText: str, sourceId: str }) } }), (x) => Plan.parse(x));
          if (!r.ok) return r.result;
          const allowed = new Set(i.channels);
          ctx.run.state.theme = r.data.theme;
          ctx.run.state.posts = r.data.posts.filter((p) => allowed.has(p.channel)).slice(0, i.postsPerWeek);
          ctx.run.state.adIdeas = i.includeAdIdeas ? r.data.adIdeas.slice(0, 2).map((a) => ({ ...a, dailyBudgetEur: Math.min(Math.max(a.dailyBudgetEur, 1), 50) })) : [];
          if (!(ctx.run.state.posts as unknown[]).length) return { status: 'blocked', blockers: ['The plan had no posts for the chosen channels'] };
          return { status: 'done' };
        },
      },
      {
        key: 'write',
        roleId: 'M09',
        label: 'Writing captions in the brand voice',
        run: async (ctx) => {
          const posts = ctx.run.state.posts as Array<z.infer<typeof Plan>['posts'][number]>;
          const plan: Evidence[] = posts.map((p, n) => ({ sourceId: `plan:${n}`, trusted: true, text: `#${n} ${p.channel} ${p.format} on ${p.day} ${p.time}: ${p.idea}` }));
          const r = await runRole(
            ctx,
            'M09',
            `Write the caption for each planned post (index = the # number) in ${ctx.run.input.language}, in the approved brand voice, within the channel's length (X: under 250 characters). Up to 8 relevant hashtags without "#". imagePrompt: one sentence describing the photo or graphic to use. Use only facts, prices and claims that appear in the approved material.`,
            [...(ctx.run.state.evidence as Evidence[]), ...plan],
            obj({ captions: { type: 'array', items: obj({ index: { type: 'integer' }, caption: str, hashtags: { type: 'array', items: str }, imagePrompt: str }) } }),
            (x) => Captions.parse(x),
          );
          if (!r.ok) return r.result;
          ctx.run.state.captions = r.data.captions;
          return { status: 'done' };
        },
      },
      {
        key: 'qa',
        roleId: 'M17',
        label: 'Checking claims, prices, limits and dates',
        run: async (ctx) => {
          const tz = ctx.company.timezone;
          const start = DateTime.fromISO(ctx.run.state.weekStart as string, { zone: tz });
          const end = DateTime.fromISO(ctx.run.state.weekEnd as string, { zone: tz });
          const approvedText = (ctx.run.state.evidence as Evidence[]).map((e) => e.text).join('\n');
          const posts = ctx.run.state.posts as Array<z.infer<typeof Plan>['posts'][number]>;
          const captions = new Map((ctx.run.state.captions as z.infer<typeof Captions>['captions']).map((c) => [c.index, c]));
          const ready: ReadyPost[] = [];
          const excluded: Array<{ idea: string; reasons: string[] }> = [];
          posts.forEach((p, n) => {
            const c = captions.get(n);
            if (!c) return excluded.push({ idea: p.idea, reasons: ['no caption was written'] });
            const post: ReadyPost = { day: p.day, time: p.time, channel: p.channel as ReadyPost['channel'], format: p.format, idea: p.idea, caption: c.caption.trim(), hashtags: c.hashtags.map((h) => h.replace(/^#/, '').replace(/\s+/g, '')).filter(Boolean), imagePrompt: c.imagePrompt };
            const problems = checkPost(post, approvedText, start, end);
            if (problems.length) excluded.push({ idea: p.idea, reasons: problems });
            else ready.push(post);
          });
          ctx.run.state.ready = ready;
          await ctx.artifact('content_plan', `Content plan, week of ${ctx.run.state.weekStart}`, { theme: ctx.run.state.theme, posts: ready, excluded }, (ctx.run.state.evidence as Evidence[]).map((e) => ({ sourceId: e.sourceId, locator: e.locator })));
          if ((ctx.run.state.adIdeas as unknown[]).length)
            await ctx.artifact('ad_ideas', 'Ad ideas (proposals only, no spend)', { note: 'Nothing is spent. Run these in your ad account if you like them.', ideas: ctx.run.state.adIdeas });
          await ctx.emit('qa.result', { ready: ready.length, excluded: excluded.length });
          if (!ready.length) return { status: 'blocked', blockers: ['No post passed the checks: ' + excluded.map((e) => e.reasons.join(', ')).join(' | ')] };
          return { status: 'done' };
        },
      },
      {
        key: 'propose',
        label: 'Putting each post in Tasks for your OK',
        run: async (ctx) => {
          const ready = ctx.run.state.ready as ReadyPost[];
          const scheduling = d.canSchedule?.() ?? false;
          if (!scheduling)
            return { status: 'blocked', blockers: [`${ready.length} posts are ready in the content plan (Artifacts). To have them scheduled in Metricool after your OK, connect your Claude routine (Connections → Claude does tasks for you) with Metricool on it, then run this again.`] };
          const ids: string[] = [];
          for (const p of ready) {
            const task = [
              `Schedule this ${p.channel} ${p.format} for the brand "${ctx.company.name}" in Metricool on ${p.day} at ${p.time} (${ctx.company.timezone}).`,
              `Caption (use exactly): ${p.caption}`,
              p.hashtags.length ? `Hashtags: ${p.hashtags.map((h) => `#${h}`).join(' ')}` : '',
              `Visual: ${p.imagePrompt}. If no image is available for a channel that needs one, create it as a post for review in Metricool instead of publishing.`,
              'Do not change the wording, do not publish anything else, and do not boost or spend money.',
            ]
              .filter(Boolean)
              .join('\n');
            const intent = d.actions.propose({
              ownerId: d.ownerId,
              type: 'delegate_task',
              space: ctx.company.id as CompanyId,
              channel: 'app',
              connectorId: 'claude_routine',
              accountId: 'claude',
              workflowId: 'WF-04',
              payload: { task, category: 'social' },
              proposedBy: 'agent:M18',
            });
            ids.push(intent.id);
          }
          ctx.run.state.actionIds = ids;
          await ctx.emit('posts.proposed', { count: ids.length });
          return { status: 'done' };
        },
      },
    ],
  };
}
