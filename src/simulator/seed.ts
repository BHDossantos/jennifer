import type { Jennifer } from '../app.js';

export const SIM_ACCOUNT = 'bruno@gmail.test';

/**
 * Local simulator seed data (spec §3): fake contacts, inbox, calendar and a
 * standing instruction, so the whole pipeline runs without real accounts.
 */
export async function seedSimulator(j: Jennifer) {
  j.capabilities.markConnected('gmail', SIM_ACCOUNT, 'Simulated Gmail');
  j.capabilities.markConnected('google_calendar', SIM_ACCOUNT, 'Simulated calendar');
  j.capabilities.recordSync('gmail');
  j.capabilities.recordSync('google_calendar');

  const marco = j.contacts.add({
    ownerId: j.ownerId,
    displayName: 'Marco Bianchi',
    spaces: ['music'],
    identities: [{ kind: 'email', value: 'marco@bianchi-music.it', verified: true, source: 'seed' }],
    relationship: 'business',
  });
  const giulia = j.contacts.add({
    ownerId: j.ownerId,
    displayName: 'Giulia Verdi',
    spaces: ['restaurant'],
    identities: [{ kind: 'email', value: 'giulia@trattoria.it', verified: true, source: 'seed' }],
  });

  const rule = j.authority.grant({
    principal: j.ownerId,
    action: 'send_message',
    mode: 'execute',
    scope: { accountIds: [SIM_ACCOUNT], spaces: ['music'], contactIds: [marco.id] },
    note: 'Routine scheduling replies to Marco',
  });
  j.authority.grant({ principal: j.ownerId, action: 'send_message', mode: 'ask', scope: { accountIds: [SIM_ACCOUNT] }, note: 'Everything else: ask me' });

  j.memory.add({
    ownerId: j.ownerId,
    kind: 'preference',
    space: 'music',
    value: 'Bruno prefers studio sessions in the afternoon, Rome time',
    source: { kind: 'bruno_statement', ref: 'seed:note:1', excerpt: 'Afternoons are best for studio.', assertedBy: j.ownerId },
    confidence: 'confirmed',
    sensitivity: 'normal',
    retention: 'indefinite',
  });

  await j.calendar.provider.upsert(
    j.calendar.buildEvent({
      calendarId: 'primary',
      title: 'Studio session with Marco',
      start: { date: '2026-10-28', time: '15:00', timeZone: 'Europe/Rome' },
      durationMin: 90,
      attendees: ['marco@bianchi-music.it'],
    }),
  );

  await j.inbound.handle(
    {
      accountId: SIM_ACCOUNT,
      connectorId: 'gmail',
      providerMessageId: 'sim-1',
      providerThreadId: 'sim-thread-1',
      from: { displayName: 'Giulia Verdi', address: 'giulia@trattoria.it' },
      to: [SIM_ACCOUNT],
      cc: [],
      subject: 'Catering quote for Saturday',
      body: 'Hi Bruno, can you confirm the catering quote of EUR 450 for Saturday?',
      headers: {},
      occurredAt: j.clock.now(),
      space: 'restaurant',
    },
    { autoDraft: true },
  );

  return { marco, giulia, rule };
}
