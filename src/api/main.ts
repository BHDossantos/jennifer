import { createJennifer } from '../app.js';
import { buildServer } from './server.js';
import { seedSimulator } from '../simulator/seed.js';

const j = createJennifer();
const ownerToken = j.config.apiToken ?? (j.config.env === 'development' ? 'dev-owner-token-change-me' : undefined);
if (!ownerToken) throw new Error('JENNIFER_API_TOKEN is required outside development');
const developerToken = process.env.JENNIFER_DEVELOPER_TOKEN;

if (j.config.env === 'development') await seedSimulator(j);

const app = buildServer(j, {
  tokens: { [ownerToken]: 'owner', ...(developerToken ? { [developerToken]: 'developer' as const } : {}) },
  webhookSecret: j.config.webhookSecret ?? (j.config.env === 'development' ? 'dev-webhook-secret-change-me' : undefined),
  logger: true,
});

// Durable-worker stand-in: drain due actions and expire memory periodically.
setInterval(() => {
  void j.actions.recoverUnknown().then(() => j.actions.runDue());
  j.memory.expireDue();
}, 5000).unref();

await app.listen({ port: j.config.port, host: '0.0.0.0' });
if (j.config.env === 'development') console.log(`Jennifer dev server on http://localhost:${j.config.port} (owner token: ${ownerToken})`);
