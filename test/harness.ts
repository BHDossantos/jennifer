import { createJennifer, type Jennifer } from '../src/app.js';
import { FakeClock } from '../src/core/util.js';
import { ScriptedModel, type ModelRequest } from '../src/core/model.js';
import { FakeEmailProvider } from '../src/connectors/fakeEmail.js';
import type { InboundEmail } from '../src/assistant/inbound.js';
import type { SendMessagePayload } from '../src/actions/sendMessage.js';
import type { Space } from '../src/core/types.js';

export const ACCOUNT = 'bruno@gmail.test';

export interface Harness {
  j: Jennifer;
  clock: FakeClock;
  gmail: FakeEmailProvider;
  model: ScriptedModel;
  setReply: (fn: (req: ModelRequest) => object) => void;
  contacts: {
    marco: string; // verified accountant, music + personal
    giulia: string; // verified, restaurant
    annaWork: string; // "Anna Rossi" — insurance
    annaFriend: string; // "Anna Rossi" — personal
  };
  email: (partial: Partial<InboundEmail> & { from: InboundEmail['from']; body: string }) => InboundEmail;
  /** A conversation in which `address` has written (so a send to them is a reply). */
  thread: (address: string, space?: Space) => string;
  sendPayload: (p: Partial<SendMessagePayload> & { to: string[]; body: string }) => SendMessagePayload;
}

let seq = 0;

export function makeHarness(): Harness {
  const clock = new FakeClock('2026-10-26T08:00:00Z'); // Monday, CET (after DST end on 25 Oct)
  const gmail = new FakeEmailProvider('gmail');
  let replyFn: (req: ModelRequest) => object = () => ({ reply: 'Thanks, noted.', cited_memory_ids: [], escalate: false, escalation_reason: '' });
  const model = new ScriptedModel((req) => JSON.stringify(replyFn(req)));
  const j = createJennifer({ clock, model, emailConnectors: [gmail], random: () => 0.5, config: { ownerId: 'bruno', homeTimeZone: 'Europe/Rome' } });

  j.capabilities.markConnected('gmail', ACCOUNT, 'Bruno personal Gmail');
  j.capabilities.markConnected('google_calendar', ACCOUNT, 'Bruno calendar');
  j.capabilities.recordSync('gmail');

  const marco = j.contacts.add({
    ownerId: 'bruno',
    displayName: 'Marco Bianchi',
    spaces: ['music', 'personal'],
    identities: [{ kind: 'email', value: 'marco@bianchi-music.it', verified: true, source: 'bruno' }],
    relationship: 'business',
  });
  const giulia = j.contacts.add({
    ownerId: 'bruno',
    displayName: 'Giulia Verdi',
    spaces: ['restaurant'],
    identities: [{ kind: 'email', value: 'giulia@trattoria.it', verified: true, source: 'bruno' }],
  });
  const annaWork = j.contacts.add({
    ownerId: 'bruno',
    displayName: 'Anna Rossi',
    spaces: ['insurance'],
    identities: [{ kind: 'email', value: 'anna.rossi@assicura.it', verified: true, source: 'bruno' }],
  });
  const annaFriend = j.contacts.add({
    ownerId: 'bruno',
    displayName: 'Anna Rossi',
    spaces: ['personal'],
    identities: [{ kind: 'email', value: 'anna.r87@gmail.com', verified: true, source: 'bruno' }],
  });

  return {
    j,
    clock,
    gmail,
    model,
    setReply: (fn) => (replyFn = fn),
    contacts: { marco: marco.id, giulia: giulia.id, annaWork: annaWork.id, annaFriend: annaFriend.id },
    email: (p) => {
      seq++;
      return {
        accountId: ACCOUNT,
        connectorId: 'gmail',
        providerMessageId: p.providerMessageId ?? `pm-${seq}`,
        providerThreadId: p.providerThreadId ?? `th-${seq}`,
        to: [ACCOUNT],
        cc: [],
        subject: 'Hello',
        headers: {},
        occurredAt: clock.now(),
        space: 'music',
        ...p,
      };
    },
    thread: (address, space = 'music') => {
      const conv = j.conversations.upsertConversation({ ownerId: 'bruno', accountId: ACCOUNT, channel: 'email', space, providerThreadId: `thread-${address}-${space}`, subject: 'Hello', participantContactIds: [] });
      j.conversations.addMessage({ ownerId: 'bruno', accountId: ACCOUNT, conversationId: conv.id, providerMessageId: `in-${address}-${space}`, direction: 'inbound', channel: 'email', status: 'received', from: { address }, to: [ACCOUNT], cc: [], bcc: [], subject: 'Hello', body: 'Hi Bruno', headers: {}, attachmentIds: [], occurredAt: clock.now(), flags: [] });
      return conv.id;
    },
    sendPayload: (p) => ({ cc: [], bcc: [], attachmentIds: [], evidence: [], subject: 'Re: Hello', ...p }),
  };
}

/** Standing instruction: routine replies to verified music contacts. */
export function grantRoutineReplies(h: Harness) {
  return h.j.authority.grant({
    principal: 'bruno',
    action: 'send_message',
    mode: 'execute',
    scope: { accountIds: [ACCOUNT], spaces: ['music'], contactIds: [h.contacts.marco] },
    note: 'Routine scheduling and administrative replies to Marco',
  });
}
