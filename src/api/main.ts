import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createDurableJennifer } from '../app.js';
import { buildServer } from './server.js';
import { seedSimulator } from '../simulator/seed.js';
import { pgDb, pgliteDb } from '../db/db.js';
import { IdentityService } from '../identity/identity.js';
import { systemClock } from '../core/util.js';
import { LocalKeyWrapper, Vault } from '../identity/vault.js';
import { GmailService } from '../connectors/gmail/service.js';
import { CalendarConnections } from '../calendar/remotes.js';

const env = process.env.JENNIFER_ENV ?? 'development';
const dev = env === 'development';

// Production and staging use Cloud SQL; development falls back to an on-disk PGlite.
let db;
if (process.env.DATABASE_URL) db = await pgDb(process.env.DATABASE_URL);
else if (dev) {
  mkdirSync('.data', { recursive: true });
  db = await pgliteDb('.data/pglite');
} else throw new Error('DATABASE_URL is required outside development');

// Sandbox: until Bruno lifts it, sends may only go to these addresses (comma-separated).
const sandboxRecipients = process.env.JENNIFER_EMAIL_SANDBOX?.split(',').map((a) => a.trim()).filter(Boolean);

// Vault master key: env in staging/production; generated once into .data/ in development.
let vaultKeys = process.env.JENNIFER_VAULT_KEYS;
if (!vaultKeys && dev) {
  const keyFile = '.data/vault.key';
  if (!existsSync(keyFile)) writeFileSync(keyFile, `1:${randomBytes(32).toString('base64')}`, { mode: 0o600 });
  vaultKeys = readFileSync(keyFile, 'utf8').trim();
}
const vault = vaultKeys ? new Vault(db, LocalKeyWrapper.fromEnv(vaultKeys)) : undefined;
// Small secrets (VAPID push keys) live in the vault, bound to this environment.
const secretBinding = { ownerId: process.env.JENNIFER_OWNER_ID ?? 'bruno', accountId: 'jennifer:app', environment: env };
const secrets = vault
  ? { get: (k: string) => vault.get(`app:${k}`, secretBinding).catch(() => undefined), set: (k: string, v: string) => vault.put(`app:${k}`, v, secretBinding) }
  : undefined;
const j = await createDurableJennifer({ db, clock: systemClock, sandboxRecipients: sandboxRecipients?.length ? sandboxRecipients : undefined, secrets });
const gmail = vault
  ? new GmailService({
      db,
      vault,
      clock: j.clock,
      audit: j.audit,
      capabilities: j.capabilities,
      ownerId: j.ownerId,
      environment: env,
      onEmail: async (email) => void (await j.inbound.handle(email, { autoDraft: true })),
      onHistory: async (email) => void (await j.inbound.handle(email, { autoDraft: false })),
      onSent: async (email) => void j.inbound.handleSent(email),
      registerConnector: (c) => j.emailConnectors.set(c.id, c),
    })
  : undefined;
if (gmail) await gmail.resume().catch((e) => console.error('Gmail resume failed:', (e as Error).message));
const calendars = vault
  ? new CalendarConnections({
      db,
      vault,
      clock: j.clock,
      audit: j.audit,
      capabilities: j.capabilities,
      calendar: j.calendar,
      ownerId: j.ownerId,
      environment: env,
      homeTimeZone: j.config.homeTimeZone,
      google:
        j.config.google.clientId && j.config.google.clientSecret && j.config.publicUrl
          ? { clientId: j.config.google.clientId, clientSecret: j.config.google.clientSecret, redirectUri: `${j.config.publicUrl.replace(/\/$/, '')}/v1/connectors/google-calendar/callback` }
          : undefined,
    })
  : undefined;
if (calendars) await calendars.resume().catch((e) => console.error('Calendar resume failed:', (e as Error).message));
const ownerToken = j.config.apiToken ?? (dev ? 'dev-owner-token-change-me' : undefined);
if (!ownerToken) throw new Error('JENNIFER_API_TOKEN (bootstrap/break-glass token) is required outside development');
const developerToken = process.env.JENNIFER_DEVELOPER_TOKEN;

const port = j.config.port;
const identity = new IdentityService(db, j.clock, j.audit, {
  // On Render the public hostname is provided automatically.
  rpId: process.env.JENNIFER_RP_ID ?? process.env.RENDER_EXTERNAL_HOSTNAME ?? 'localhost',
  rpName: 'Jennifer',
  origins: (process.env.JENNIFER_ORIGINS ?? (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : `http://localhost:${port}`)).split(','),
});

// Simulator data is opt-in so it never mixes with a real connected inbox.
if (dev && process.env.JENNIFER_SEED === '1' && j.contacts.list(j.ownerId).length === 0) await seedSimulator(j);

const app = buildServer(j, {
  tokens: { [ownerToken]: 'owner', ...(developerToken ? { [developerToken]: 'developer' as const } : {}) },
  webhookSecret: j.config.webhookSecret ?? (dev ? 'dev-webhook-secret-change-me' : undefined),
  logger: true,
  identity,
  gmail,
  calendars,
});

// Worker loop stand-in until the durable workflow engine lands (Week 6):
// reconcile unknown outcomes, run due actions, expire temporary memory.
const timer = setInterval(() => {
  void j.actions
    .recoverUnknown()
    .then(() => j.actions.runDue())
    .catch((e) => app.log.error(e));
  j.memory.expireDue();
}, 5000);
// Mission scheduler: due background runs (read-only research) once a minute.
// Calendar mirror refresh every 10 minutes.
const calendarTimer = setInterval(() => void calendars?.syncNow().catch((e) => app.log.error(e)), 10 * 60_000);
calendarTimer.unref();
const missionTimer = setInterval(() => {
  void j.missions.tick().catch((e) => app.log.error(e));
  void j.notifications.flushHeld().catch((e) => app.log.error(e));
}, 60_000);
missionTimer.unref();
// Retention purge once a day (and shortly after boot).
const retentionRun = () => {
  void j.retention.purge().catch((e) => app.log.error(e));
  // Nightly learning: turn Bruno's edits into style rules.
  void j.styleLearner.learn().catch((e) => app.log.error(e));
};
const retentionTimer = setInterval(retentionRun, 24 * 3600_000);
retentionTimer.unref();
setTimeout(retentionRun, 60_000).unref();
timer.unref();

async function shutdown(signal: string) {
  app.log.info(`${signal}: draining`);
  clearInterval(timer);
  clearInterval(missionTimer);
  clearInterval(calendarTimer);
  clearInterval(retentionTimer);
  await app.close();
  await j.store.flush();
  await db!.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port, host: '0.0.0.0' });
if (dev) console.log(`Jennifer dev server on http://localhost:${port} (bootstrap owner token: ${ownerToken})`);
