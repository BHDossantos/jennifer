import { describe, expect, it } from 'vitest';
import { AnthropicProvider, AnthropicToolModel, toClaudeMessages, type ClaudeClient } from '../../src/core/anthropic.js';
import { runAgentLoop, type AgentItem } from '../../src/core/agentLoop.js';
import { textModel, loadConfig } from '../../src/core/config.js';

function fakeClient(responses: Array<Record<string, unknown>>) {
  const requests: any[] = [];
  const client: ClaudeClient = {
    beta: {
      messages: {
        create: async (body: any) => {
          requests.push(structuredClone(body));
          const r = responses.shift()!;
          return { id: 'msg', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, ...r } as any;
        },
      },
    },
  };
  return { client, requests };
}

describe('Claude provider', () => {
  it('sends effort and the default refusal fallback, omits thinking, reads text', async () => {
    const { client, requests } = fakeClient([{ content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: '{"ok":true}' }] }]);
    const p = new AnthropicProvider({ client, effort: 'high' });
    const r = await p.complete({ system: 'sys', input: 'hi', model: 'claude-opus-5-5', promptVersion: 'v1', jsonSchema: { name: 'x', schema: { type: 'object' } } });
    expect(r.text).toBe('{"ok":true}');
    expect(requests[0]).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'], output_config: { effort: 'high', format: { type: 'json_schema' } } });
    expect(requests[0].thinking).toBeUndefined();
  });

  it('a refusal is an error, never an empty draft', async () => {
    const { client } = fakeClient([{ content: [], stop_reason: 'refusal' }]);
    await expect(new AnthropicProvider({ client }).complete({ system: 's', input: 'i', model: 'm', promptVersion: 'v' })).rejects.toThrow(/declined/);
  });

  it('runs a tool loop with append-only history: the assistant turn (thinking + tool_use) replays verbatim', async () => {
    const turn1 = [
      { type: 'thinking', thinking: 'check the calendar', signature: 'sig1' },
      { type: 'tool_use', id: 'tu_1', name: 'get_calendar', input: { day: 'today' } },
    ];
    const { client, requests } = fakeClient([{ content: turn1, stop_reason: 'tool_use' }, { content: [{ type: 'text', text: 'You have the dentist at 15:00.' }] }]);
    const r = await runAgentLoop({
      model: new AnthropicToolModel({ client }),
      modelName: 'claude-opus-5-5',
      system: 'sys',
      task: 'What is on today?',
      tools: [{ name: 'get_calendar', description: 'calendar', parameters: { type: 'object', properties: { day: { type: 'string' } } } }],
      limits: { maxSteps: 4, maxToolCalls: 4 },
      exec: async (name, args) => JSON.stringify({ name, args, events: ['Dentist 15:00'] }),
    });
    expect(r.finalText).toBe('You have the dentist at 15:00.');
    const second = requests[1].messages;
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({ role: 'assistant', content: turn1 });
    expect(second[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
    expect(requests[0].tools[0]).toMatchObject({ name: 'get_calendar', input_schema: { type: 'object' } });
  });

  it('drops thinking from earlier turns and converts foreign history', () => {
    const h: AgentItem[] = [
      { type: 'user', text: 'first' },
      { type: 'opaque', raw: { provider: 'anthropic', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'answer' }] } },
      { type: 'assistant', text: 'answer', raw: { provider: 'anthropic' } },
      { type: 'tool_result', callId: 'orphan', output: '{}' },
      { type: 'assistant', text: 'from openai', raw: { type: 'message' } },
      { type: 'user', text: 'second' },
    ];
    const m = toClaudeMessages(h);
    expect(m[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'answer' }] });
    expect(JSON.stringify(m)).not.toMatch(/thinking/);
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });

  it('MODEL_PROVIDER selects the brain; auto prefers OpenAI, falls back to Claude', () => {
    expect(textModel(loadConfig({ ANTHROPIC_API_KEY: 'k' } as any))).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(textModel(loadConfig({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o' } as any)).provider).toBe('openai');
    expect(textModel(loadConfig({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o', MODEL_PROVIDER: 'anthropic' } as any)).provider).toBe('anthropic');
  });
});
