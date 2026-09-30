/**
 * Secrets redaction filter applied before telemetry, audit details or logs
 * leave the service (spec §4). Conservative by design: false positives are
 * cheaper than a leaked refresh token or one-time code.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]'],
  [/\bya29\.[A-Za-z0-9._-]+/g, '[REDACTED_OAUTH_TOKEN]'],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[REDACTED_REFRESH_TOKEN]'],
  [/("?(?:refresh_token|access_token|client_secret|password|api_key|secret)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED_CARD]'],
  [/\b(cvv|cvc|security code)\b\D{0,12}\d{3,4}\b/gi, '$1 [REDACTED]'],
  [/\b(code|otp|verification code|passcode|pin)\b(\s*(?:is|:)?\s*)\d{4,8}\b/gi, '$1$2[REDACTED_CODE]'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/** True when text looks like it carries an authentication code (never goes to memory). */
export function containsAuthenticationCode(text: string): boolean {
  return /\b(verification code|one[- ]time (?:pass)?code|otp|security code|2fa code|login code)\b/i.test(text);
}
