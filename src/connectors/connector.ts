/**
 * Adapter contract for any connector that can perform an external write.
 * The executor is the only caller; the model never touches a connector.
 */
export interface OutboundMessage {
  accountId: string;
  conversationId: string;
  providerThreadId?: string;
  inReplyToProviderMessageId?: string;
  /** RFC 5322 threading headers (Message-IDs without angle brackets). */
  replyHeaders?: { inReplyTo: string; references: string[] };
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  body: string;
  attachments: Array<{ id: string; filename: string; storageRef: string }>;
  idempotencyKey: string;
}

export type SendResult =
  | { kind: 'accepted'; providerMessageId: string; deliveryStatus: 'accepted' | 'delivered' }
  | { kind: 'rejected'; error: string; retryable: boolean }
  | { kind: 'timeout' };

export class ConnectorTimeout extends Error {}

export interface MessagingConnector {
  readonly id: string;
  send(msg: OutboundMessage): Promise<SendResult>;
  /** Reconciliation: look up what the provider actually has for this key. */
  findByIdempotencyKey(accountId: string, key: string): Promise<{ providerMessageId: string } | undefined>;
  /** How long after a send attempt a reconciliation miss still counts as "not yet visible". */
  readonly reconcileGraceMs?: number;
}
