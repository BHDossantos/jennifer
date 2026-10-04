import { z } from 'zod';

/**
 * Model identifiers and provider settings live in configuration, not code
 * (spec §3). Pin versions after evaluation.
 */
const ConfigSchema = z.object({
  env: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  port: z.coerce.number().default(8787),
  ownerId: z.string().default('bruno'),
  homeTimeZone: z.string().default('Europe/Rome'),
  apiToken: z.string().min(16).optional(),
  webhookSecret: z.string().min(16).optional(),
  openai: z.object({
    apiKey: z.string().optional(),
    webhookSecret: z.string().optional(),
    baseUrl: z.string().url().default('https://api.openai.com/v1'),
    reasoningModel: z.string().default('gpt-5'),
    fastModel: z.string().default('gpt-5-mini'),
    realtimeModel: z.string().default('gpt-realtime'),
    promptVersion: z.string().default('jennifer-2026-10-01'),
  }),
  /** Claude via the Anthropic API: an alternative brain for chat, missions, drafts and briefs. Voice and phone stay on OpenAI Realtime. */
  anthropic: z.object({
    apiKey: z.string().optional(),
    model: z.string().default('claude-opus-5-5'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  }),
  /** Which provider writes text: auto = OpenAI when its key is set, else Claude. */
  modelProvider: z.enum(['auto', 'openai', 'anthropic']).default('auto'),
  /** SMS on Jennifer's number (Twilio, or SignalWire via apiBase). */
  sms: z.object({
    accountSid: z.string().optional(),
    authToken: z.string().optional(),
    from: z.string().regex(/^\+\d{8,15}$/).optional(),
    apiBase: z.string().url().optional(),
    /** Bruno's own mobile (E.164) for urgent alerts when push is unavailable. */
    alertTo: z.string().regex(/^\+\d{8,15}$/).optional(),
  }),
  /** Bruno's iMessage/SMS through BlueBubbles Server on his Mac. */
  imessage: z.object({
    url: z.string().url().optional(),
    password: z.string().optional(),
    webhookToken: z.string().min(24).optional(),
    method: z.enum(['apple-script', 'private-api']).default('apple-script'),
  }),
  /** WhatsApp Business via Meta's Cloud API (coexistence with the WhatsApp Business app). */
  whatsapp: z.object({
    token: z.string().optional(),
    phoneNumberId: z.string().optional(),
    appSecret: z.string().optional(),
    verifyToken: z.string().optional(),
    graphVersion: z.string().default('v21.0'),
    /** Which of Bruno's spaces this business number belongs to. */
    space: z.enum(['personal', 'insurance', 'music', 'restaurant', 'nonprofit', 'technology']).default('personal'),
  }),
  /** Google sign-in (OAuth client from a Google Cloud project) for Google Calendar read/write. */
  google: z.object({ clientId: z.string().optional(), clientSecret: z.string().optional() }),
  /** Public base URL (for verifying signed provider webhooks). */
  publicUrl: z.string().url().optional(),
  /** Bruno's own number for warm transfers from Jennifer's phone line (E.164). */
  transferNumber: z.string().regex(/^\+\d{8,15}$/).optional(),
  /** Retention in days, configured separately per data class (spec §17). 0 = keep. */
  retention: z.object({
    messagesDays: z.coerce.number().int().min(0).default(365),
    callsDays: z.coerce.number().int().min(0).default(90),
    auditDays: z.coerce.number().int().min(0).default(730),
    feedbackDays: z.coerce.number().int().min(0).default(365),
  }),
  budgets: z.object({
    monthlyCeilingEur: z.coerce.number().default(1000),
    perTaskMaxEur: z.coerce.number().default(0.5),
    perCallMaxMinutes: z.coerce.number().default(20),
  }),
});
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = ConfigSchema.parse({
    env: env.JENNIFER_ENV,
    port: env.PORT,
    ownerId: env.JENNIFER_OWNER_ID,
    homeTimeZone: env.JENNIFER_HOME_TZ,
    apiToken: env.JENNIFER_API_TOKEN,
    webhookSecret: env.JENNIFER_WEBHOOK_SECRET,
    openai: {
      apiKey: env.OPENAI_API_KEY,
      webhookSecret: env.OPENAI_WEBHOOK_SECRET,
      baseUrl: env.OPENAI_BASE_URL,
      reasoningModel: env.JENNIFER_REASONING_MODEL,
      fastModel: env.JENNIFER_FAST_MODEL,
      realtimeModel: env.JENNIFER_REALTIME_MODEL,
      promptVersion: env.JENNIFER_PROMPT_VERSION,
    },
    anthropic: { apiKey: env.ANTHROPIC_API_KEY || undefined, model: env.JENNIFER_CLAUDE_MODEL || undefined, effort: env.JENNIFER_CLAUDE_EFFORT || undefined },
    modelProvider: env.MODEL_PROVIDER || undefined,
    sms: {
      accountSid: env.TWILIO_ACCOUNT_SID || undefined,
      authToken: env.TWILIO_AUTH_TOKEN || undefined,
      from: env.JENNIFER_SMS_FROM || undefined,
      apiBase: env.TWILIO_API_BASE || undefined,
      alertTo: env.JENNIFER_ALERT_SMS_TO || undefined,
    },
    imessage: {
      url: env.JENNIFER_IMESSAGE_URL || undefined,
      password: env.JENNIFER_IMESSAGE_PASSWORD || undefined,
      webhookToken: env.JENNIFER_IMESSAGE_WEBHOOK_TOKEN || undefined,
      method: env.JENNIFER_IMESSAGE_METHOD || undefined,
    },
    whatsapp: {
      token: env.WHATSAPP_TOKEN || undefined,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || undefined,
      appSecret: env.WHATSAPP_APP_SECRET || undefined,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || undefined,
      graphVersion: env.WHATSAPP_GRAPH_VERSION || undefined,
      space: env.JENNIFER_WHATSAPP_SPACE || undefined,
    },
    google: { clientId: env.GOOGLE_CLIENT_ID || undefined, clientSecret: env.GOOGLE_CLIENT_SECRET || undefined },
    publicUrl: env.JENNIFER_PUBLIC_URL || (env.RENDER_EXTERNAL_URL ? env.RENDER_EXTERNAL_URL : undefined),
    transferNumber: env.JENNIFER_TRANSFER_NUMBER || undefined,
    retention: {
      messagesDays: env.JENNIFER_RETAIN_MESSAGES_DAYS || undefined,
      callsDays: env.JENNIFER_RETAIN_CALLS_DAYS || undefined,
      auditDays: env.JENNIFER_RETAIN_AUDIT_DAYS || undefined,
      feedbackDays: env.JENNIFER_RETAIN_FEEDBACK_DAYS || undefined,
    },
    budgets: {
      monthlyCeilingEur: env.JENNIFER_MONTHLY_CEILING_EUR,
      perTaskMaxEur: env.JENNIFER_TASK_MAX_EUR,
      perCallMaxMinutes: env.JENNIFER_CALL_MAX_MINUTES,
    },
  });
  if (cfg.env === 'production' && (!cfg.apiToken || !cfg.webhookSecret)) throw new Error('Production requires JENNIFER_API_TOKEN and JENNIFER_WEBHOOK_SECRET');
  return cfg;
}

/** The provider and model that write Jennifer's text (drafts, chat, missions, briefs). */
export function textModel(cfg: Config): { provider: 'openai' | 'anthropic' | 'none'; model: string } {
  const p = cfg.modelProvider === 'auto' ? (cfg.openai.apiKey ? 'openai' : cfg.anthropic.apiKey ? 'anthropic' : 'none') : cfg.modelProvider;
  if (p === 'anthropic' && cfg.anthropic.apiKey) return { provider: 'anthropic', model: cfg.anthropic.model };
  if (p === 'openai' && cfg.openai.apiKey) return { provider: 'openai', model: cfg.openai.reasoningModel };
  return { provider: 'none', model: cfg.openai.reasoningModel };
}
