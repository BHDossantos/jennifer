/**
 * Guard against fabricated outcomes in outgoing text (spec §6): Jennifer may
 * not state that a payment cleared, equipment was returned, or an application
 * was submitted without evidence or an attributed statement from Bruno.
 */
export interface EvidenceRef {
  kind: 'provider_receipt' | 'bruno_statement' | 'document' | 'memory';
  sourceId: string;
  supports: ClaimKind[];
}

export type ClaimKind = 'payment_completed' | 'item_returned' | 'application_submitted' | 'document_signed' | 'callback_promised';

const CLAIM_PATTERNS: Array<[ClaimKind, RegExp]> = [
  ['payment_completed', /\b(payment|invoice|transfer|bill)\b[^.!?]{0,60}\b(has been|was|is)\s+(paid|cleared|settled|sent|processed|completed)\b|\b(i|we|bruno)\s+(have|has)\s+(paid|settled|transferred)\b|\bpagamento\b[^.!?]{0,40}\b(effettuato|eseguito|pago|realizado)\b/i],
  ['item_returned', /\b(equipment|device|item|keys?|package|laptop)\b[^.!?]{0,60}\b(has been|was)\s+(returned|shipped back|sent back|dropped off)\b/i],
  ['application_submitted', /\b(application|form|claim|request)\b[^.!?]{0,60}\b(has been|was)\s+(submitted|filed|sent)\b|\b(i|we|bruno)\s+(have|has)\s+(applied|submitted|filed)\b/i],
  ['document_signed', /\b(contract|agreement|document)\b[^.!?]{0,60}\b(has been|was|is)\s+signed\b|\b(i|we|bruno)\s+(have|has)\s+signed\b/i],
  ['callback_promised', /\b(bruno|he|she|they)\s+will\s+(call|get back to)\s+you\b/i],
];

export function detectClaims(text: string): ClaimKind[] {
  return CLAIM_PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
}

export function unsupportedClaims(text: string, evidence: EvidenceRef[]): ClaimKind[] {
  const supported = new Set(evidence.flatMap((e) => e.supports));
  return detectClaims(text).filter((c) => !supported.has(c));
}
