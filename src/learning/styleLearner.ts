import type { Clock } from '../core/util.js';
import type { ModelProvider } from '../core/model.js';
import type { AuditLog } from '../audit/audit.js';
import type { FeedbackStore, Feedback } from './feedback.js';

const RULES_SCHEMA = {
  name: 'style_rules',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['rules'],
    properties: { rules: { type: 'array', items: { type: 'string' } } },
  },
};

/**
 * Continuous learning without retraining a model (spec §13): every night
 * Jennifer compares her drafts with what Bruno actually approved and turns
 * the differences into short writing-style rules per space and contact.
 * Style rules apply automatically; they can never change permissions,
 * recipients, money or contact behavior, and Bruno can drop any of them.
 */
export class StyleLearner {
  constructor(
    private d: { clock: Clock; feedback: FeedbackStore; model?: ModelProvider; modelName: string; promptVersion: string; audit: AuditLog },
  ) {}

  async learn(opts: { minExamples?: number; maxRulesPerScope?: number } = {}): Promise<number> {
    if (!this.d.model) return 0;
    const edits = this.d.feedback.list().filter((f) => (f.kind === 'edited' || f.kind === 'poor_tone') && f.approvedFinal && f.approvedFinal !== f.originalCandidate);
    const groups = new Map<string, Feedback[]>();
    for (const f of edits) {
      const k = `${f.space}|${f.contactId ?? ''}`;
      groups.set(k, [...(groups.get(k) ?? []), f]);
    }
    let added = 0;
    for (const [k, fs] of groups) {
      if (fs.length < (opts.minExamples ?? 2)) continue;
      const [space, contactId] = k.split('|') as [Feedback['space'], string];
      const examples = fs
        .slice(-12)
        .map((f, i) => `Example ${i + 1}\nJennifer wrote:\n${f.originalCandidate.slice(0, 1500)}\nBruno approved:\n${f.approvedFinal!.slice(0, 1500)}${f.note ? `\nBruno's note: ${f.note}` : ''}`)
        .join('\n\n');
      const res = await this.d.model.complete({
        system: [
          'Compare drafts with the versions Bruno approved and write short, general writing-style rules that would have produced his versions.',
          'Only style: tone, length, greeting, sign-off, language, formality, formatting, word choice.',
          'Never write rules about who to contact, money, promises, attachments, permissions or sending without approval.',
          `At most ${opts.maxRulesPerScope ?? 5} rules, each under 25 words.`,
        ].join('\n'),
        input: examples,
        model: this.d.modelName,
        promptVersion: this.d.promptVersion,
        jsonSchema: RULES_SCHEMA,
      });
      let rules: string[] = [];
      try {
        rules = (JSON.parse(res.text) as { rules: string[] }).rules;
      } catch {
        continue;
      }
      // Belt and braces: anything that smells like authority is dropped, not applied.
      const safe = rules.filter((r) => r.length < 200 && !/\b(send|forward|cc|bcc|pay|transfer|money|attach|password|permission|approve|without asking|contact)\b/i.test(r));
      added += this.d.feedback.replaceLearnedStyle({ space, contactId: contactId || undefined }, safe, fs.slice(-3).map((f) => f.approvedFinal!));
    }
    if (added) this.d.audit.record('jennifer', 'learning.style_updated', undefined, { rules: added });
    return added;
  }
}
