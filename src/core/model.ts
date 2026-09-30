import { redactSecrets } from '../security/redaction.js';

/**
 * Model provider adapter so providers can change without touching business
 * rules (spec §3). The model only produces text and *proposals*; it cannot
 * execute anything or grant itself permission.
 */
export interface ModelRequest {
  system: string;
  input: string;
  model: string;
  promptVersion: string;
  maxOutputTokens?: number;
  /** Optional JSON schema for structured output. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export interface ModelResponse {
  text: string;
  model: string;
  promptVersion: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ModelProvider {
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/** OpenAI Responses API adapter. API key stays server side. */
export class OpenAIProvider implements ModelProvider {
  constructor(
    private apiKey: string,
    private baseUrl = 'https://api.openai.com/v1',
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      instructions: req.system,
      input: req.input,
      max_output_tokens: req.maxOutputTokens ?? 1200,
      store: false,
    };
    if (req.jsonSchema) body.text = { format: { type: 'json_schema', name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true } };
    const res = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw Object.assign(new Error(`OpenAI ${res.status}: ${redactSecrets(await res.text())}`), { transient: res.status >= 500 || res.status === 429 });
    const json = (await res.json()) as {
      output_text?: string;
      output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
      usage?: { input_tokens: number; output_tokens: number };
    };
    const text =
      json.output_text ??
      (json.output ?? [])
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === 'output_text')
        .map((c) => c.text ?? '')
        .join('');
    return {
      text,
      model: req.model,
      promptVersion: req.promptVersion,
      usage: json.usage ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens } : undefined,
    };
  }
}

/** Deterministic provider for tests and the simulator. */
export class ScriptedModel implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  constructor(private respond: (req: ModelRequest) => string) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    return { text: this.respond(req), model: req.model, promptVersion: req.promptVersion };
  }
}
