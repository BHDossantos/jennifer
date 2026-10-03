import Anthropic from '@anthropic-ai/sdk';
import { JenniferError } from '../core/types.js';
import { redactSecrets } from '../security/redaction.js';
import { safeFetchText } from '../security/untrusted.js';
import type { ClaudeClient } from '../core/anthropic.js';

/**
 * Web research for chat and missions (spec §12 research role). Results are
 * third-party content: callers label them untrusted, and nothing here can
 * act. Page reads go through the egress-safe fetcher (no internal
 * addresses, redirects re-checked, size capped); search uses the model
 * provider's own hosted web search.
 */
export interface WebSearchResult {
  answer: string;
  sources: Array<{ title?: string; url: string }>;
}

export interface WebResearchOptions {
  provider: 'openai' | 'anthropic' | 'none';
  model: string;
  openaiKey?: string;
  openaiBaseUrl?: string;
  anthropicKey?: string;
  anthropicClient?: ClaudeClient;
  /** Models used by ask() when consulting each provider. */
  openaiModel?: string;
  claudeModel?: string;
  fetchImpl?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
}

/** Readable text from HTML: drop scripts/styles/markup, keep link targets sparsely. */
export function htmlToText(html: string): { title?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const text = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
  return { title, text };
}

export class WebResearch {
  constructor(private o: WebResearchOptions) {}

  get available(): boolean {
    return this.o.provider !== 'none';
  }

  async read(url: string, maxChars = 20_000): Promise<{ url: string; title?: string; text: string; truncated: boolean }> {
    let res;
    try {
      res = await safeFetchText(url, { headers: { accept: 'text/html,text/plain;q=0.9', 'user-agent': 'JenniferAssistant/1.0 (+personal assistant; reads pages on request)' }, maxBytes: 3 * 1024 * 1024, fetchImpl: this.o.fetchImpl, resolve: this.o.resolve });
    } catch (e) {
      throw new JenniferError('web.fetch_failed', `Could not read that page: ${(e as Error).message}`);
    }
    if (res.status >= 400) throw new JenniferError('web.fetch_failed', `The page returned ${res.status}`);
    const { title, text } = /<html|<body|<div|<p[\s>]/i.test(res.text) ? htmlToText(res.text) : { title: undefined, text: res.text };
    return { url, title, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }

  async search(query: string): Promise<WebSearchResult> {
    if (this.o.provider === 'anthropic') return this.searchClaude(query);
    if (this.o.provider === 'openai') return this.searchOpenAI(query);
    throw new JenniferError('web.unavailable', 'Web search needs an OpenAI or Anthropic key on the server');
  }

  /**
   * Ask GPT and Claude (whichever keys are configured), each with live web
   * search, and return both answers side by side. Uses Bruno's own API keys.
   */
  async ask(question: string, which: 'both' | 'openai' | 'claude' = 'both'): Promise<{ answers: Array<{ from: 'GPT' | 'Claude'; answer: string; sources: WebSearchResult['sources'] } | { from: 'GPT' | 'Claude'; error: string }> }> {
    const jobs: Array<Promise<{ from: 'GPT' | 'Claude'; answer: string; sources: WebSearchResult['sources'] } | { from: 'GPT' | 'Claude'; error: string }>> = [];
    const wrap = (from: 'GPT' | 'Claude', p: Promise<WebSearchResult>) => p.then((r) => ({ from, ...r })).catch((e: Error) => ({ from, error: redactSecrets(e.message) }));
    if (which !== 'claude' && this.o.openaiKey) jobs.push(wrap('GPT', this.searchOpenAI(question, this.o.openaiModel ?? 'gpt-5')));
    if (which !== 'openai' && (this.o.anthropicKey || this.o.anthropicClient)) jobs.push(wrap('Claude', this.searchClaude(question, this.o.claudeModel ?? 'claude-opus-5-5')));
    if (!jobs.length) throw new JenniferError('web.unavailable', 'Asking GPT or Claude needs OPENAI_API_KEY or ANTHROPIC_API_KEY on the server');
    return { answers: await Promise.all(jobs) };
  }

  private async searchOpenAI(query: string, model = this.o.model): Promise<WebSearchResult> {
    const res = await (this.o.fetchImpl ?? fetch)(`${this.o.openaiBaseUrl ?? 'https://api.openai.com/v1'}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.o.openaiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, tools: [{ type: 'web_search' }], input: `Search the web and answer concisely with sources: ${query}`, store: false }),
    });
    if (!res.ok) throw new JenniferError('web.search_failed', `Web search failed (${res.status}): ${redactSecrets(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { output?: Array<{ type: string; content?: Array<{ type: string; text?: string; annotations?: Array<{ type: string; url?: string; title?: string }> }> }> };
    const parts = (json.output ?? []).filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text');
    const sources = parts.flatMap((p) => p.annotations ?? []).filter((a) => a.type === 'url_citation' && a.url).map((a) => ({ url: a.url!, title: a.title }));
    return { answer: parts.map((p) => p.text ?? '').join(''), sources: dedupe(sources) };
  }

  private async searchClaude(query: string, model = this.o.model): Promise<WebSearchResult> {
    const client = this.o.anthropicClient ?? (new Anthropic({ apiKey: this.o.anthropicKey }) as unknown as ClaudeClient);
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: `Search the web and answer concisely with sources: ${query}` }];
    let msg;
    // A long server-side search can pause; resume a bounded number of times.
    for (let i = 0; i < 4; i++) {
      msg = await client.beta.messages.create({
        model,
        max_tokens: 4000,
        messages: messages as never,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }] as never,
      });
      if (msg.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: msg.content });
    }
    if (!msg || msg.stop_reason === 'refusal') throw new JenniferError('web.search_failed', 'Web search was declined');
    const texts = msg.content.filter((b) => b.type === 'text') as Array<{ text: string; citations?: Array<{ url?: string; title?: string }> | null }>;
    const sources = texts.flatMap((t) => t.citations ?? []).filter((c) => c.url).map((c) => ({ url: c.url!, title: c.title ?? undefined }));
    return { answer: texts.map((t) => t.text).join(''), sources: dedupe(sources) };
  }
}

function dedupe(xs: Array<{ url: string; title?: string }>) {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(x.url) && (seen.add(x.url), true)).slice(0, 10);
}
