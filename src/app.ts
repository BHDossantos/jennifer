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
import { DeadLetterQueue, EventStore } from './events/events.js';
import { CapabilityRegistry } from './connectors/capabilities.js';
import type { MessagingConnector } from './connectors/connector.js';
import { FakeEmailProvider } from './connectors/fakeEmail.js';
import { ActionService } from './actions/service.js';
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
  const events = new EventStore(clock);
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

  const actions = new ActionService({ clock, audit, authority, controls, suppressions, conversations, deadLetters, random: opts.random });
  actions.register(new SendMessageHandler(contacts, conversations, emailConnectors, capabilities));
  actions.register(new CalendarActionHandler('create_event', calendar, contacts, capabilities));
  actions.register(new CalendarActionHandler('modify_event', calendar, contacts, capabilities));

  const model: ModelProvider =
    opts.model ??
    (config.openai.apiKey
      ? new OpenAIProvider(config.openai.apiKey, config.openai.baseUrl)
      : new ScriptedModel(() => JSON.stringify({ reply: 'Thank you for your message. Bruno will review it.', cited_memory_ids: [], escalate: true, escalation_reason: 'no model configured' })));

  const inbound = new InboundProcessor({ clock, config, ownerId, events, conversations, contacts, actions, memory, suppressions, feedback, audit, model });

  const tools = new ToolRegistry(() => clock.now().getTime());
  registerStandardTools(tools, { ownerId, conversations, memory, calendar, actions });

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
    dailyBrief: (urgentMessages: Array<{ id: string; summary: string }> = []) =>
      buildDailyBrief({ clock, timeZone: config.homeTimeZone, capabilities, actions, deadLetters, memory, ownerId, urgentMessages }),
  };
}

export type Jennifer = ReturnType<typeof createJennifer>;

const Space = z.enum(SPACES);

/** The only tools a model can call. External writes return proposals. */
function registerStandardTools(
  tools: ToolRegistry,
  d: { ownerId: string; conversations: ConversationStore; memory: MemoryStore; calendar: CalendarService; actions: ActionService },
): void {
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
