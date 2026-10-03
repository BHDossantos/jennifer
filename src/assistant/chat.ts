import { z } from 'zod';
import { JenniferError, SPACES } from '../core/types.js';
import { type Clock, newId } from '../core/util.js';
import { runAgentLoop, type AgentItem, type ToolCallingModel, type ToolSpec } from '../core/agentLoop.js';
import { renderUntrusted, wrapUntrusted } from '../security/untrusted.js';
import type { ToolRegistry, ToolContext } from '../tools/registry.js';
import type { MemoryStore } from '../memory/memory.js';
import type { AuditLog } from '../audit/audit.js';
import { personaInstructions, DEFAULT_VOICE, type DeliveryMode } from '../voice/persona.js';

/**
 * "Ask Jennifer": text conversation with the same tools as voice. Facts
 * Bruno states are remembered only when the memory quotes his own words;
 * anything else (e.g. inspired by an email) waits for review.
 */
const CHAT_TOOLS = ['get_today_brief', 'list_pending_decisions', 'list_missions', 'search_messages', 'read_thread', 'retrieve_memory', 'create_draft', 'get_calendar', 'find_free_slots', 'propose_event', 'search_ai_history', 'read_ai_conversation'];
const MAX_HISTORY = 40;

interface ChatSession {
  id: string;
  history: AgentItem[];
  lastUserText: string;
  updatedAt: Date;
}

export class ChatService {
  private sessions = new Map<string, ChatSession>();

  constructor(
    private d: { clock: Clock; ownerId: string; tools: ToolRegistry; memory: MemoryStore; audit: AuditLog; model?: ToolCallingModel; modelName: string; homeTimeZone: string },
  ) {}

  async send(input: { sessionId?: string; message: string; mode?: DeliveryMode }): Promise<{ sessionId: string; reply: string; remembered: string[]; pendingReview: string[] }> {
    if (!this.d.model) throw new JenniferError('chat.no_model', 'Chat needs OPENAI_API_KEY or ANTHROPIC_API_KEY on the server');
    const s = (input.sessionId && this.sessions.get(input.sessionId)) || { id: newId('chat'), history: [], lastUserText: '', updatedAt: this.d.clock.now() };
    s.lastUserText = input.message;
    const remembered: string[] = [];
    const pendingReview: string[] = [];

    const ctx: ToolContext = { ownerId: this.d.ownerId, role: 'chat', allowedTools: new Set(CHAT_TOOLS), scopes: new Set(['brief:read', 'actions:read', 'messages:read', 'memory:read', 'messages:propose', 'calendar:read', 'calendar:propose', 'history:read']) };
    const specs: ToolSpec[] = this.d.tools.forRole(ctx).map((t) => {
      const { $schema: _s, ...parameters } = t.schema as Record<string, unknown>;
      return { name: t.name, description: t.description, parameters };
    });
    const Remember = z.object({
      fact: z.string().min(3).max(500),
      kind: z.enum(['preference', 'instruction', 'profile_fact', 'project_record', 'contact_context']),
      space: z.enum(SPACES).default('personal'),
      quote: z.string().min(3).max(500).describe("Bruno's exact words from this message that state the fact"),
    });
    const { $schema: _r, ...rememberParams } = z.toJSONSchema(Remember) as Record<string, unknown>;
    specs.push({ name: 'remember', description: 'Save something Bruno told you to memory. Quote his exact words.', parameters: rememberParams });

    const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
    let tainted = false;
    const result = await runAgentLoop({
      model: this.d.model,
      modelName: this.d.modelName,
      system: [
        personaInstructions(input.mode ?? 'private', DEFAULT_VOICE, 'en'),
        'You are chatting by text with Bruno in the Jennifer app. Be concise; plain text, no markdown tables.',
        `Bruno's home time zone is ${this.d.homeTimeZone}. Current time: ${this.d.clock.now().toISOString()}.`,
        'For anything Bruno discussed with ChatGPT or Claude, use search_ai_history; you only see what he exported or shared, so say so when it is not there.',
        'Use tools for facts about his day, inbox, missions and memory. Proposing or drafting a message never sends it: say it is waiting for his approval.',
        'When Bruno tells you something worth keeping (a preference, an instruction, a fact), call remember with his exact words as the quote.',
      ].join('\n'),
      task: input.message,
      prior: s.history,
      tools: specs,
      limits: { maxSteps: 8, maxToolCalls: 10 },
      exec: async (name, args) => {
        if (name === 'remember') {
          const a = Remember.parse(args);
          // Direct saves need a real quote of this message that actually states the fact,
          // and never after third-party content entered this turn (it could have steered the model).
          const fromBruno = !tainted && quoteSupportsFact(norm(s.lastUserText), norm(a.quote), norm(a.fact));
          const entry = this.d.memory.add({
            ownerId: this.d.ownerId,
            kind: a.kind,
            space: a.space,
            value: a.fact,
            // Not quoted from Bruno → an inference that stays inactive until he approves it.
            source: { kind: fromBruno ? 'bruno_statement' : 'inference', ref: `chat:${s.id}`, excerpt: a.quote, assertedBy: this.d.ownerId },
            confidence: fromBruno ? 'confirmed' : 'inferred',
            sensitivity: 'normal',
            retention: 'indefinite',
            lastVerifiedAt: fromBruno ? this.d.clock.now() : undefined,
            status: fromBruno ? 'active' : 'pending_review',
          });
          (fromBruno ? remembered : pendingReview).push(entry.value);
          this.d.audit.record('jennifer', fromBruno ? 'memory.remembered' : 'memory.pending_review', entry.id, { kind: a.kind });
          return JSON.stringify(fromBruno ? { saved: true } : { saved: false, pendingReview: true, why: 'Only Bruno’s own words are saved directly; this waits for his review.' });
        }
        const out = JSON.stringify(await this.d.tools.invoke(name, args, ctx));
        // Every tool result can carry text written by someone else (mail, invites, notes).
        tainted = true;
        return renderUntrusted(wrapUntrusted(`tool:${name}`, out), newId('n').slice(2, 10));
      },
    });
    s.history = (result.history ?? []).slice(-MAX_HISTORY);
    // Never start a stored history with an orphaned tool result.
    while (s.history.length && s.history[0]!.type === 'tool_result') s.history.shift();
    s.updatedAt = this.d.clock.now();
    this.sessions.set(s.id, s);
    const reply = result.finalText || (result.stoppedBy === 'final' ? '' : 'I ran out of steps on that one. Could you narrow it down?');
    return { sessionId: s.id, reply, remembered, pendingReview };
  }

  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

/**
 * True when `quote` appears in Bruno's message and carries the fact: the
 * quote must be substantial and contain most of the fact's content words.
 */
export function quoteSupportsFact(message: string, quote: string, fact: string): boolean {
  if (quote.length < 8 || !message.includes(quote)) return false;
  const words = (t: string) => t.split(/[^\p{L}\p{N}@.]+/u).filter((w) => w.length >= 4);
  const factWords = words(fact).filter((w) => w !== 'bruno' && w !== "bruno's" && w !== 'bruno’s');
  if (factWords.length === 0) return quote.includes(fact);
  const q = new Set(words(quote));
  const hit = factWords.filter((w) => q.has(w) || [...q].some((x) => x.startsWith(w.slice(0, 5)))).length;
  return hit / factWords.length >= 0.5;
}

