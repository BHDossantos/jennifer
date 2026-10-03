import { z } from 'zod';
import { SPACES } from './core/types.js';
import { type Clock, systemClock } from './core/util.js';
import { type Config, loadConfig } from './core/config.js';
import { type ModelProvider, OpenAIProvider, ScriptedModel } from './core/model.js';
import { AuditLog } from './audit/audit.js';
import { AuthorityRegistry } from './policy/authority.js';
import { Controls, SuppressionList } from './policy/controls.js';
import { ContactDirectory } from './contacts/contacts.js';
import { ConversationStore } from './events/conversations.js';
import { DeadLetterQueue, EventStore, type EventLog } from './events/events.js';
import { CapabilityRegistry } from './connectors/capabilities.js';
import type { MessagingConnector } from './connectors/connector.js';
import { FakeEmailProvider } from './connectors/fakeEmail.js';
import { ActionService, type ActionDurability } from './actions/service.js';
import { SendMessageHandler } from './actions/sendMessage.js';
import { CalendarActionHandler, CalendarService, FakeCalendarProvider } from './calendar/calendar.js';
import { MemoryStore } from './memory/memory.js';
import { ChatGptImporter } from './memory/chatgptImport.js';
import { AgentCoordinator } from './agents/agents.js';
import { WorkflowRegistry, buildDailyBrief } from './workflows/workflows.js';
import { FeedbackStore, ModelRegistry } from './learning/feedback.js';
import { ToolRegistry } from './tools/registry.js';
import { InboundProcessor } from './assistant/inbound.js';
import { DateTime } from 'luxon';
import type { Db } from './db/db.js';
import { MemorySettings, PgSettings, type SettingsStore } from './core/settings.js';
import { RealtimeVoiceService } from './voice/realtime.js';
import { OpenAIToolModel, type ToolCallingModel } from './core/agentLoop.js';
import { MemoryMissionStore, PgMissionStore, type MissionStore } from './missions/missions.js';
import { MissionService } from './missions/runner.js';
import { migrate } from './db/migrate.js';
import { PgEventLog, PgStateStore, ensureOwner } from './db/pgStore.js';
import { readFileSync, existsSync } from 'node:fs';
import { InventorySchema, type Inventory } from './setup/inventory.js';

export interface JenniferOptions {
  clock?: Clock;
  config?: Partial<Config>;
  model?: ModelProvider;
  emailConnectors?: MessagingConnector[];
  calendarProvider?: FakeCalendarProvider;
  random?: () => number;
  /** Path to the account/device inventory JSON; defaults to config/inventory.json when present. */
  inventoryPath?: string | null;
  /** Durable event log (Postgres in production); defaults to in-memory. */
  events?: EventLog;
  durability?: ActionDurability;
  /** Sandbox mode for first live tests: only these recipients can receive sends. */
  sandboxRecipients?: string[];
  settings?: SettingsStore;
  /** Inject a fetch for OpenAI calls (tests). */
  fetchImpl?: typeof fetch;
  toolModel?: ToolCallingModel;
  missionStore?: MissionStore;
}

/**
 * Composition root: one modular service (spec §3). Storage here is
 * in-memory; the PostgreSQL schema in db/migrations mirrors these entities
 * and repositories swap in behind the same classes.
 */
export function createJennifer(opts: JenniferOptions = {}) {
  const clock = opts.clock ?? systemClock;
  const base = loadConfig({ ...process.env, JENNIFER_ENV: process.env.JENNIFER_ENV ?? 'development' });
  const config: Config = { ...base, ...opts.config, openai: { ...base.openai, ...opts.config?.openai }, budgets: { ...base.budgets, ...opts.config?.budgets } };
  const ownerId = config.ownerId;

  const audit = new AuditLog(clock);
  const authority = new AuthorityRegistry(clock, audit);
  const controls = new Controls(audit);
  const suppressions = new SuppressionList(clock, audit);
  const contacts = new ContactDirectory();
  const conversations = new ConversationStore(clock);
  const events: EventLog = opts.events ?? new EventStore(clock);
  const deadLetters = new DeadLetterQueue(clock);
  const capabilities = new CapabilityRegistry(clock);
  const memory = new MemoryStore(clock);
  const importer = new ChatGptImporter(clock, memory);
  const agents = new AgentCoordinator(clock);
  const workflows = new WorkflowRegistry(clock, suppressions);
  const feedback = new FeedbackStore(clock);
  const modelRegistry = new ModelRegistry(clock);
  const calendar = new CalendarService(clock, opts.calendarProvider ?? new FakeCalendarProvider());

  const emailConnectors = new Map<string, MessagingConnector>();
  for (const c of opts.emailConnectors ?? [new FakeEmailProvider('gmail')]) emailConnectors.set(c.id, c);

  const actions = new ActionService({ clock, audit, authority, controls, suppressions, conversations, deadLetters, random: opts.random, durability: opts.durability });
  actions.register(new SendMessageHandler(contacts, conversations, emailConnectors, capabilities, { clock, sandboxRecipients: opts.sandboxRecipients }));
  actions.register(new CalendarActionHandler('create_event', calendar, contacts, capabilities));
  actions.register(new CalendarActionHandler('modify_event', calendar, contacts, capabilities));

  const model: ModelProvider =
    opts.model ??
    (config.openai.apiKey
      ? new OpenAIProvider(config.openai.apiKey, config.openai.baseUrl)
      : new ScriptedModel(() => JSON.stringify({ reply: 'Thank you for your message. Bruno will review it.', cited_memory_ids: [], escalate: true, escalation_reason: 'no model configured' })));

  const inbound = new InboundProcessor({ clock, config, ownerId, events, conversations, contacts, actions, memory, suppressions, feedback, audit, model });

  const tools = new ToolRegistry(() => clock.now().getTime());
  const dailyBrief = (urgentMessages: Array<{ id: string; summary: string }> = []) =>
    buildDailyBrief({ clock, timeZone: config.homeTimeZone, capabilities, actions, deadLetters, memory, ownerId, urgentMessages });
  registerStandardTools(tools, { ownerId, conversations, memory, calendar, actions, dailyBrief });
  const settings = opts.settings ?? new MemorySettings();
  const voice = new RealtimeVoiceService({ apiKey: config.openai.apiKey, baseUrl: config.openai.baseUrl, model: config.openai.realtimeModel, fetchImpl: opts.fetchImpl });
  const toolModel = opts.toolModel ?? (config.openai.apiKey ? new OpenAIToolModel(config.openai.apiKey, config.openai.baseUrl, opts.fetchImpl) : undefined);
  const missions = new MissionService({
    clock,
    ownerId,
    store: opts.missionStore ?? new MemoryMissionStore(),
    authority,
    actions,
    conversations,
    tools,
    audit,
    model: toolModel,
    modelName: config.openai.reasoningModel,
    emailAccount: () => {
      const g = capabilities.get('gmail');
      return g?.connected && g.accountId ? { accountId: g.accountId, connectorId: 'gmail' } : undefined;
    },
  });
  tools.register({
    name: 'list_missions',
    description: "Bruno's missions (always-on agents): status, latest unreviewed results and recent activity.",
    input: z.object({}),
    requiredScopes: ['brief:read'],
    sideEffect: 'read',
    timeoutMs: 3000,
    rateLimitPerMinute: 30,
    retry: { maxAttempts: 1, retryOn: 'never' },
    run: async () =>
      (await missions.list())
        .filter((m) => m.status !== 'archived')
        .map((m) => ({ title: m.title, status: m.status, lastRunAt: m.lastRunAt, newResults: m.results.filter((r) => r.status === 'new').slice(0, 3).map((r) => r.body), recent: m.activity.slice(-5).map((a) => a.text) })),
  });

  const inventoryPath = opts.inventoryPath === undefined ? 'config/inventory.json' : opts.inventoryPath;
  const inventory: Inventory | undefined = inventoryPath && existsSync(inventoryPath) ? InventorySchema.parse(JSON.parse(readFileSync(inventoryPath, 'utf8'))) : undefined;

  return {
    clock,
    config,
    inventory,
    ownerId,
    audit,
    authority,
    controls,
    suppressions,
    contacts,
    conversations,
    events,
    deadLetters,
    capabilities,
    memory,
    importer,
    agents,
    workflows,
    feedback,
    modelRegistry,
    calendar,
    emailConnectors,
    actions,
    inbound,
    tools,
    model,
    settings,
    voice,
    missions,
    dailyBrief,
  };
}

export type Jennifer = ReturnType<typeof createJennifer>;

const Space = z.enum(SPACES);

/** The only tools a model can call. External writes return proposals. */
function registerStandardTools(
  tools: ToolRegistry,
  d: { ownerId: string; conversations: ConversationStore; memory: MemoryStore; calendar: CalendarService; actions: ActionService; dailyBrief: () => ReturnType<typeof buildDailyBrief> },
): void {
  tools.register({
    name: 'get_today_brief',
    description: "Bruno's daily brief: decisions waiting, urgent messages, deadlines, completed work, problems and account health.",
    input: z.object({}),
    requiredScopes: ['brief:read'],
    sideEffect: 'read',
    timeoutMs: 3000,
    rateLimitPerMinute: 30,
    retry: { maxAttempts: 1, retryOn: 'never' },
    run: async () => d.dailyBrief(),
  });
  tools.register({
    name: 'list_pending_decisions',
    description: 'Actions waiting for Bruno to approve or decline, with the exact recipients and text.',
    input: z.object({}),
    requiredScopes: ['actions:read'],
    sideEffect: 'read',
    timeoutMs: 3000,
    rateLimitPerMinute: 30,
    retry: { maxAttempts: 1, retryOn: 'never' },
    run: async () =>
      d.actions.list({ state: 'awaiting_decision' }).map((a) => {
        const p = a.payload as { to?: string[]; subject?: string; body?: string };
        return { id: a.id, type: a.type, to: p.to, subject: p.subject, body: p.body, why: a.decisionReasons };
      }),
  });
  tools.register({
    name: 'search_messages',
    description: 'Search messages within permitted spaces.',
    input: z.object({ query: z.string().min(2), spaces: z.array(Space).min(1) }),
    requiredScopes: ['messages:read'],
    sideEffect: 'read',
    timeoutMs: 5000,
    rateLimitPerMinute: 60,
    retry: { maxAttempts: 2, retryOn: 'transient' },
    run: async (i) => d.conversations.searchMessages(d.ownerId, i.query, i.spaces).map((m) => ({ id: m.id, subject: m.subject, from: m.from.address, at: m.occurredAt })),
  });
  tools.register({
    name: 'read_thread',
    description: 'Read a conversation thread (returned as untrusted content).',
    input: z.object({ conversationId: z.string() }),
    requiredScopes: ['messages:read'],
    sideEffect: 'read',
    timeoutMs: 5000,
    rateLimitPerMinute: 60,
    retry: { maxAttempts: 2, retryOn: 'transient' },
    run: async (i) => d.conversations.messagesIn(i.conversationId).map((m) => ({ id: m.id, direction: m.direction, from: m.from.address, body: m.body, flags: m.flags, untrusted: true })),
  });
  tools.register({
    name: 'retrieve_memory',
    description: 'Retrieve relevant memory with source references.',
    input: z.object({ text: z.string(), spaces: z.array(Space).min(1), contactId: z.string().optional() }),
    requiredScopes: ['memory:read'],
    sideEffect: 'read',
    timeoutMs: 3000,
    rateLimitPerMinute: 120,
    retry: { maxAttempts: 2, retryOn: 'transient' },
    run: async (i) =>
      d.memory.retrieve({ ownerId: d.ownerId, text: i.text, spaces: i.spaces, contactId: i.contactId, maxSensitivity: 'normal' }).map((r) => ({
        id: r.entry.id,
        value: r.entry.value,
        freshness: r.freshness,
        source: r.sourceRef,
      })),
  });
  tools.register({
    name: 'get_free_busy',
    description: 'Free/busy for a calendar between two ISO instants.',
    input: z.object({ calendarId: z.string(), fromUtc: z.string(), toUtc: z.string() }),
    requiredScopes: ['calendar:read'],
    sideEffect: 'read',
    timeoutMs: 5000,
    rateLimitPerMinute: 60,
    retry: { maxAttempts: 2, retryOn: 'transient' },
    run: async (i) => d.calendar.busy(i.calendarId, DateTime.fromISO(i.fromUtc), DateTime.fromISO(i.toUtc)),
  });
  const proposeSend = z.object({
    accountId: z.string(),
    connectorId: z.string(),
    conversationId: z.string().optional(),
    space: Space,
    to: z.array(z.string().email()).min(1),
    cc: z.array(z.string().email()).default([]),
    subject: z.string().optional(),
    body: z.string().min(1),
    attachmentIds: z.array(z.string()).default([]),
  });
  for (const name of ['create_draft', 'send_message'] as const) {
    tools.register({
      name,
      description: name === 'send_message' ? 'Propose sending a message. Execution is decided by policy, not by you.' : 'Create a draft for Bruno to review.',
      input: proposeSend,
      requiredScopes: ['messages:propose'],
      sideEffect: name === 'send_message' ? 'external_write' : 'draft',
      timeoutMs: 5000,
      rateLimitPerMinute: 20,
      retry: { maxAttempts: 1, retryOn: 'never' },
      run: async (i, ctx) => {
        const intent = d.actions.propose({
          ownerId: d.ownerId,
          type: 'send_message',
          space: i.space,
          channel: 'email',
          connectorId: i.connectorId,
          accountId: i.accountId,
          conversationId: i.conversationId,
          payload: { to: i.to, cc: i.cc, bcc: [], subject: i.subject, body: i.body, attachmentIds: i.attachmentIds, evidence: [] },
          proposedBy: `agent:${ctx.role}`,
        });
        if (name === 'create_draft') d.actions.requireDecision(intent.id, `agent:${ctx.role}`, 'draft requested');
        return { actionId: intent.id, state: intent.state, reasons: intent.decisionReasons };
      },
    });
  }
  tools.register({
    name: 'create_follow_up',
    description: 'Record a follow-up item for Bruno.',
    input: z.object({ summary: z.string().min(3), dueLocal: z.string().optional() }),
    requiredScopes: ['tasks:write'],
    sideEffect: 'draft',
    timeoutMs: 2000,
    rateLimitPerMinute: 30,
    retry: { maxAttempts: 1, retryOn: 'never' },
    run: async (i) => ({ recorded: true, summary: i.summary }),
  });
}

/**
 * Durable composition: Postgres (or PGlite) for events, audit, authority
 * rules, contacts and the action outbox. Runs migrations, rehydrates state
 * and recovers interrupted sends as 'unknown' for reconciliation.
 */
export async function createDurableJennifer(opts: JenniferOptions & { db: Db }) {
  const clock = opts.clock ?? systemClock;
  await migrate(opts.db);
  const ownerId = opts.config?.ownerId ?? loadConfig({ ...process.env, JENNIFER_ENV: process.env.JENNIFER_ENV ?? 'development' }).ownerId;
  await ensureOwner(opts.db, ownerId);
  const store = new PgStateStore(opts.db, ownerId);
  const j = createJennifer({ ...opts, clock, events: new PgEventLog(opts.db, clock), durability: store, settings: new PgSettings(opts.db, ownerId), missionStore: new PgMissionStore(opts.db) });

  j.authority.restore(await store.loadRules());
  j.contacts.restore(await store.loadContacts());
  const { intents, approvals } = await store.loadActions();
  j.actions.restore(intents, approvals);

  j.audit.addSink((ev) => store.audit(ev));
  j.authority.onChange((_v, ruleId) => store.rule(j.authority.get(ruleId)));
  j.contacts.onChange((c) => store.contact(c));
  return Object.assign(j, { db: opts.db, store });
}
