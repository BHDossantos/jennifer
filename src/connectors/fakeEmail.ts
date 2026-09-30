import { newId } from '../core/util.js';
import type { MessagingConnector, OutboundMessage, SendResult } from './connector.js';

export type FakeFault = 'timeout_after_send' | 'timeout_before_send' | 'reject_transient' | 'reject_permanent' | 'disconnected';

/**
 * Local simulator mailbox (spec §3: "a local simulator with fake inboxes").
 * Supports fault injection so ambiguous-send reconciliation can be tested.
 */
export class FakeEmailProvider implements MessagingConnector {
  readonly id: string;
  readonly sent: Array<OutboundMessage & { providerMessageId: string }> = [];
  private faults: FakeFault[] = [];

  constructor(id = 'gmail') {
    this.id = id;
  }

  /** Queue faults consumed by subsequent send calls, in order. */
  injectFault(...f: FakeFault[]): void {
    this.faults.push(...f);
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const fault = this.faults.shift();
    if (fault === 'disconnected') return { kind: 'rejected', error: 'invalid_grant: token revoked', retryable: false };
    if (fault === 'reject_permanent') return { kind: 'rejected', error: 'recipient rejected', retryable: false };
    if (fault === 'reject_transient') return { kind: 'rejected', error: '503 backend error', retryable: true };
    if (fault === 'timeout_before_send') return { kind: 'timeout' };
    // Provider-side idempotency is NOT assumed: a resend really duplicates.
    const providerMessageId = newId('gm');
    this.sent.push({ ...msg, providerMessageId });
    if (fault === 'timeout_after_send') return { kind: 'timeout' };
    return { kind: 'accepted', providerMessageId, deliveryStatus: 'accepted' };
  }

  async findByIdempotencyKey(accountId: string, key: string): Promise<{ providerMessageId: string } | undefined> {
    const m = this.sent.find((s) => s.accountId === accountId && s.idempotencyKey === key);
    return m ? { providerMessageId: m.providerMessageId } : undefined;
  }
}
