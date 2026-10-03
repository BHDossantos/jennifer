import { redactSecrets } from '../security/redaction.js';

/**
 * Tool-calling model port (spec §12). The model chooses tools; the loop
 * executes them through Jennifer's own code (registry, policy, executor),
 * so the model never holds credentials or direct side effects.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type AgentItem =
  | { type: 'user'; text: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string; raw?: unknown }
  | { type: 'tool_result'; callId: string; output: string }
  | { type: 'assistant'; text: string; raw?: unknown }
  | { type: 'opaque'; raw: unknown }; // provider items (e.g. encrypted reasoning) passed back verbatim

export interface AgentStep {
  items: AgentItem[]; // new items produced by the model this step
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ToolCallingModel {
  step(req: { system: string; history: AgentItem[]; tools: ToolSpec[]; model: string }): Promise<AgentStep>;
}

export interface LoopLimits {
  maxSteps: number;
  maxToolCalls: number;
}

export interface LoopResult {
  finalText: string;
  steps: number;
  toolCalls: number;
  stoppedBy: 'final' | 'max_steps' | 'max_tool_calls' | 'budget' | 'canceled';
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Run a bounded agent loop. `exec` runs one tool call and returns its
 * output text (already labeled as untrusted where appropriate); throwing
 * `StopLoop` ends the run (budget exhausted, canceled).
 */
export async function runAgentLoop(o: {
  model: ToolCallingModel;
  modelName: string;
  system: string;
  task: string;
  tools: ToolSpec[];
  limits: LoopLimits;
  exec: (name: string, args: unknown) => Promise<string>;
  onStep?: (usage: { inputTokens: number; outputTokens: number }) => void;
}): Promise<LoopResult> {
  const history: AgentItem[] = [{ type: 'user', text: o.task }];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let toolCalls = 0;
  for (let step = 1; step <= o.limits.maxSteps; step++) {
    const r = await o.model.step({ system: o.system, history, tools: o.tools, model: o.modelName });
    history.push(...r.items);
    if (r.usage) {
      usage.inputTokens += r.usage.inputTokens;
      usage.outputTokens += r.usage.outputTokens;
      o.onStep?.(r.usage);
    }
    const calls = r.items.filter((i): i is Extract<AgentItem, { type: 'tool_call' }> => i.type === 'tool_call');
    if (calls.length === 0) {
      const text = r.items.filter((i): i is Extract<AgentItem, { type: 'assistant' }> => i.type === 'assistant').map((i) => i.text).join('\n').trim();
      return { finalText: text, steps: step, toolCalls, stoppedBy: 'final', usage };
    }
    for (const c of calls) {
      if (toolCalls >= o.limits.maxToolCalls) return { finalText: '', steps: step, toolCalls, stoppedBy: 'max_tool_calls', usage };
      toolCalls++;
      let output: string;
      try {
        let args: unknown = {};
        try {
          args = c.arguments ? JSON.parse(c.arguments) : {};
        } catch {
          throw new Error('arguments were not valid JSON');
        }
        output = await o.exec(c.name, args);
      } catch (e) {
        if (e instanceof StopLoop) return { finalText: '', steps: step, toolCalls, stoppedBy: e.reason, usage };
        output = JSON.stringify({ error: redactSecrets((e as Error).message) });
      }
      history.push({ type: 'tool_result', callId: c.callId, output });
    }
  }
  return { finalText: '', steps: o.limits.maxSteps, toolCalls, stoppedBy: 'max_steps', usage };
}

export class StopLoop extends Error {
  constructor(readonly reason: 'budget' | 'canceled') {
    super(reason);
  }
}

/** OpenAI Responses API with function tools; store:false, so history is resent each step. */
export class OpenAIToolModel implements ToolCallingModel {
  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.openai.com/v1',
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async step(req: { system: string; history: AgentItem[]; tools: ToolSpec[]; model: string }): Promise<AgentStep> {
    const input = req.history.flatMap((i): unknown[] => {
      switch (i.type) {
        case 'user':
          return [{ role: 'user', content: i.text }];
        case 'tool_call':
          return [i.raw ?? { type: 'function_call', call_id: i.callId, name: i.name, arguments: i.arguments }];
        case 'tool_result':
          return [{ type: 'function_call_output', call_id: i.callId, output: i.output }];
        case 'assistant':
          return [i.raw ?? { role: 'assistant', content: i.text }];
        case 'opaque':
          return [i.raw];
      }
    });
    const res = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        instructions: req.system,
        input,
        tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
        store: false,
        include: ['reasoning.encrypted_content'],
      }),
    });
    if (!res.ok) throw Object.assign(new Error(`OpenAI ${res.status}: ${redactSecrets(await res.text())}`), { transient: res.status >= 500 || res.status === 429 });
    const json = (await res.json()) as { output?: Array<Record<string, any>>; usage?: { input_tokens: number; output_tokens: number } };
    const items: AgentItem[] = (json.output ?? []).map((o): AgentItem => {
      if (o.type === 'function_call') return { type: 'tool_call', callId: o.call_id, name: o.name, arguments: o.arguments ?? '{}', raw: o };
      if (o.type === 'message')
        return {
          type: 'assistant',
          text: (o.content ?? []).filter((c: { type: string }) => c.type === 'output_text').map((c: { text: string }) => c.text).join(''),
          raw: o,
        };
      return { type: 'opaque', raw: o };
    });
    return { items, usage: json.usage ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens } : undefined };
  }
}

/** Deterministic tool-calling model for tests and the simulator. */
export class ScriptedToolModel implements ToolCallingModel {
  readonly requests: Array<{ system: string; history: AgentItem[]; tools: ToolSpec[] }> = [];
  constructor(private script: (req: { history: AgentItem[]; tools: ToolSpec[]; step: number }) => AgentItem[]) {}
  async step(req: { system: string; history: AgentItem[]; tools: ToolSpec[]; model: string }): Promise<AgentStep> {
    this.requests.push({ system: req.system, history: [...req.history], tools: req.tools });
    return { items: this.script({ history: req.history, tools: req.tools, step: this.requests.length }), usage: { inputTokens: 500, outputTokens: 100 } };
  }
}
