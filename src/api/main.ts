import { mkdirSync } from 'node:fs';
import { createDurableJennifer } from '../app.js';
import { buildServer } from './server.js';
import { seedSimulator } from '../simulator/seed.js';
import { pgDb, pgliteDb } from '../db/db.js';
import { IdentityService } from '../identity/identity.js';
import { systemClock } from '../core/util.js';

const env = process.env.JENNIFER_ENV ?? 'development';
const dev = env === 'development';

// Production and staging use Cloud SQL; development falls back to an on-disk PGlite.
let db;
if (process.env.DATABASE_URL) db = await pgDb(process.env.DATABASE_URL);
else if (dev) {
  mkdirSync('.data', { recursive: true });
  db = await pgliteDb('.data/pglite');
} else throw new Error('DATABASE_URL is required outside development');

const j = await createDurableJennifer({ db, clock: systemClock });
const ownerToken = j.config.apiToken ?? (dev ? 'dev-owner-token-change-me' : undefined);
if (!ownerToken) throw new Error('JENNIFER_API_TOKEN (bootstrap/break-glass token) is required outside development');
const developerToken = process.env.JENNIFER_DEVELOPER_TOKEN;

const port = j.config.port;
const identity = new IdentityService(db, j.clock, j.audit, {
  rpId: process.env.JENNIFER_RP_ID ?? 'localhost',
  rpName: 'Jennifer',
  origins: (process.env.JENNIFER_ORIGINS ?? `http://localhost:${port}`).split(','),
});

if (dev && j.contacts.list(j.ownerId).length === 0) await seedSimulator(j);

const app = buildServer(j, {
  tokens: { [ownerToken]: 'owner', ...(developerToken ? { [developerToken]: 'developer' as const } : {}) },
  webhookSecret: j.config.webhookSecret ?? (dev ? 'dev-webhook-secret-change-me' : undefined),
  logger: true,
  identity,
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
timer.unref();

async function shutdown(signal: string) {
  app.log.info(`${signal}: draining`);
  clearInterval(timer);
  await app.close();
  await j.store.flush();
  await db!.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port, host: '0.0.0.0' });
if (dev) console.log(`Jennifer dev server on http://localhost:${port} (bootstrap owner token: ${ownerToken})`);
