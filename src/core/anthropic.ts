import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaContentBlockParam, BetaMessage, BetaMessageParam, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { redactSecrets } from '../security/redaction.js';
import type { AgentItem, AgentStep, ToolCallingModel, ToolSpec } from './agentLoop.js';
import type { ModelProvider, ModelRequest, ModelResponse } from './model.js';

/**
 * Claude (Anthropic API) as Jennifer's model provider, selected with
 * MODEL_PROVIDER=anthropic. Same contract as the OpenAI adapters: the model
 * only returns text and tool *proposals*; Jennifer's code executes.
 *
 * - Thinking is always on for Claude Opus 5.5, so `thinking` is omitted;
 *   depth is set with `output_config.effort`.
 * - `fallbacks: "default"` lets the API re-run a policy-declined request on
 *   Anthropic's recommended fallback model inside the same call.
 * - Tool-loop history is append-only: each assistant turn is replayed with
 *   its exact content blocks (thinking included), which keeps preserved
 *   thinking valid across tool calls.
 */
export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The slice of the SDK client Jennifer uses (lets tests inject a fake). */
export interface ClaudeClient {
  beta: { messages: { create(body: MessageCreateParamsNonStreaming & { betas?: string[] }): Promise<BetaMessage> } };
}

export interface ClaudeOptions {
  apiKey?: string;
  client?: ClaudeClient;
  effort?: Effort;
  maxTokens?: number;
  /** Server-side refusal fallback (default on). */
  fallbacks?: boolean;
}

function makeClient(o: ClaudeOptions): ClaudeClient {
  return o.client ?? (new Anthropic({ apiKey: o.apiKey, maxRetries: 2 }) as unknown as ClaudeClient);
}

async function create(client: ClaudeClient, o: ClaudeOptions, body: Omit<MessageCreateParamsNonStreaming, 'max_tokens'>): Promise<BetaMessage> {
  const req = {
    ...body,
    max_tokens: o.maxTokens ?? 16000,
    output_config: { ...(body.output_config ?? {}), effort: o.effort ?? 'medium' },
    ...(o.fallbacks === false ? {} : { fallbacks: 'default' as const, betas: [FALLBACK_BETA] }),
  };
  try {
    let msg = await client.beta.messages.create(req);
    // pause_turn (server-side work paused): resume by sending the turn back, a bounded number of times.
    for (let i = 0; i < 3 && msg.stop_reason === 'pause_turn'; i++) {
      msg = await client.beta.messages.create({ ...req, messages: [...req.messages, { role: 'assistant', content: msg.content as BetaContentBlockParam[] }] });
    }
    return msg;
  } catch (e) {
    const status = (e as { status?: number }).status;
    throw Object.assign(new Error(`Claude ${status ?? ''}: ${redactSecrets((e as Error).message)}`), { transient: status === undefined || status >= 500 || status === 429 || status === 529 });
  }
}

const textOf = (content: BetaContentBlock[]) =>
  content
    .filter((b): b is Extract<BetaContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');

const usageOf = (m: BetaMessage) => ({ inputTokens: (m.usage.input_tokens ?? 0) + (m.usage.cache_read_input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0), outputTokens: m.usage.output_tokens ?? 0 });

/** Single-shot completions (drafts, briefs, extraction). */
export class AnthropicProvider implements ModelProvider {
  private client: ClaudeClient;
  constructor(private o: ClaudeOptions = {}) {
    this.client = makeClient(o);
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const msg = await create(this.client, { ...this.o, maxTokens: Math.max(req.maxOutputTokens ?? 0, this.o.maxTokens ?? 16000) }, {
      model: req.model,
      system: req.system,
      messages: [{ role: 'user', content: req.input }],
      ...(req.jsonSchema ? { output_config: { format: { type: 'json_schema', schema: req.jsonSchema.schema } } } : {}),
    });
    if (msg.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined this request'), { transient: false, refusal: true });
    return { text: textOf(msg.content), model: msg.model, promptVersion: req.promptVersion, usage: usageOf(msg) };
  }
}

/** Raw marker on items produced by this adapter. */
interface ClaudeRaw {
  provider: 'anthropic';
  /** The assistant turn's exact content; present on the turn's first item only. */
  content?: BetaContentBlock[];
}
const isClaude = (raw: unknown): raw is ClaudeRaw => !!raw && typeof raw === 'object' && (raw as ClaudeRaw).provider === 'anthropic';

/** Tool-calling loop step (chat, missions). */
export class AnthropicToolModel implements ToolCallingModel {
  private client: ClaudeClient;
  constructor(private o: ClaudeOptions = {}) {
    this.client = makeClient(o);
  }

  async step(req: { system: string; history: AgentItem[]; tools: ToolSpec[]; model: string }): Promise<AgentStep> {
    const msg = await create(this.client, this.o, {
      model: req.model,
      system: req.system,
      messages: toClaudeMessages(req.history),
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: { type: 'object' as const, ...t.parameters } })) } : {}),
    });
    if (msg.stop_reason === 'refusal') return { items: [{ type: 'assistant', text: "I can't help with that one.", raw: { provider: 'anthropic' } satisfies ClaudeRaw }], usage: usageOf(msg) };
    const items: AgentItem[] = [{ type: 'opaque', raw: { provider: 'anthropic', content: msg.content } satisfies ClaudeRaw }];
    for (const b of msg.content) {
      if (b.type === 'tool_use') items.push({ type: 'tool_call', callId: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}), raw: { provider: 'anthropic' } satisfies ClaudeRaw });
    }
    const text = textOf(msg.content);
    if (text) items.push({ type: 'assistant', text, raw: { provider: 'anthropic' } satisfies ClaudeRaw });
    return { items, usage: usageOf(msg) };
  }
}

/**
 * Agent history → Claude messages. Claude's own turns replay verbatim;
 * items from another provider (e.g. a chat started on OpenAI) become
 * plain text/tool blocks. Thinking from earlier user turns is dropped
 * (allowed, and stored chat history is truncated, so its prefix is not
 * guaranteed to match), while the current turn's tool loop keeps it.
 */
export function toClaudeMessages(history: AgentItem[]): BetaMessageParam[] {
  const lastUser = history.map((i) => i.type).lastIndexOf('user');
  const out: BetaMessageParam[] = [];
  const toolUseIds = new Set<string>();
  const push = (role: 'user' | 'assistant', blocks: BetaContentBlockParam[]) => {
    if (blocks.length === 0) return;
    const prev = out.at(-1);
    if (prev && prev.role === role) (prev.content as BetaContentBlockParam[]).push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  history.forEach((i, idx) => {
    switch (i.type) {
      case 'user':
        push('user', [{ type: 'text', text: i.text }]);
        break;
      case 'opaque':
        if (isClaude(i.raw) && i.raw.content) {
          const blocks = (i.raw.content as BetaContentBlockParam[]).filter((b) => idx > lastUser || (b.type !== 'thinking' && b.type !== 'redacted_thinking'));
          for (const b of blocks) if (b.type === 'tool_use') toolUseIds.add(b.id);
          push('assistant', blocks);
        }
        break;
      case 'tool_call':
        if (toolUseIds.has(i.callId)) break; // already in the replayed turn
        let input: unknown = {};
        try {
          input = JSON.parse(i.arguments || '{}');
        } catch {
          /* keep {} */
        }
        toolUseIds.add(i.callId);
        push('assistant', [{ type: 'tool_use', id: i.callId, name: i.name, input }]);
        break;
      case 'tool_result':
        if (toolUseIds.has(i.callId)) push('user', [{ type: 'tool_result', tool_use_id: i.callId, content: i.output }]);
        else push('user', [{ type: 'text', text: `(earlier tool result) ${i.output}` }]);
        break;
      case 'assistant':
        if (isClaude(i.raw)) break; // text is inside the replayed turn
        if (i.text) push('assistant', [{ type: 'text', text: i.text }]);
        break;
    }
  });
  // The API expects the conversation to open with a user turn.
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continuing our conversation)' }] });
  return out;
}
