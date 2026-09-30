/**
 * Untrusted content handling (spec §17). Emails, messages, websites,
 * documents and tool outputs are data, never instructions. They are wrapped
 * with provenance labels before reaching a model, and suspicious content is
 * flagged and preserved as evidence. Enforcement does NOT rely on detection:
 * tool permissions are checked in code by the executor regardless.
 */
export interface UntrustedBlock {
  source: string; // e.g. 'email:msg_123 from alice@example.com'
  content: string;
  flags: string[];
}

const INJECTION_PATTERNS: Array<[string, RegExp]> = [
  ['instruction_override', /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|your|all)\b[^.]{0,20}\b(instructions|rules|prompt|guidelines)\b/i],
  ['exfiltration_request', /\b(forward|send|share|export|upload)\b[^.]{0,60}\b(all|every|entire)\b[^.]{0,40}\b(emails?|messages|statements|documents|files|contacts|history)\b/i],
  ['credential_request', /\b(send|share|provide|tell|give)\b[^.]{0,40}\b(password|verification code|2fa|otp|one[- ]time code|authentication code|security code|login code)\b/i],
  ['settings_change', /\b(change|update|disable|turn off)\b[^.]{0,40}\b(settings|permissions|forwarding|rules|security|2fa)\b/i],
  ['role_play', /\b(you are now|act as|new system prompt|developer mode)\b|\b(system|assistant)\s*:/i],
  ['hidden_text', /[\u200B-\u200F\u2060\uFEFF]|<span[^>]*(display:\s*none|font-size:\s*0)/i],
];

export function detectInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
}

/** Remove markup that could hide instructions; keep visible text as evidence. */
export function sanitizeForModel(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, '')
    .replace(/\s+\n/g, '\n')
    .trim();
}

export function wrapUntrusted(source: string, content: string): UntrustedBlock {
  return { source, content: sanitizeForModel(content), flags: detectInjection(content) };
}

/**
 * Render an untrusted block for a model prompt. Delimiters are randomized per
 * call so embedded text cannot forge a closing tag.
 */
export function renderUntrusted(block: UntrustedBlock, nonce: string): string {
  const flagNote = block.flags.length ? ` flags="${block.flags.join(',')}"` : '';
  const safe = block.content.split(`</untrusted-${nonce}>`).join('');
  return `<untrusted-${nonce} source="${block.source}"${flagNote}>\n${safe}\n</untrusted-${nonce}>`;
}

/** Egress policy for link fetching: no internal destinations, http(s) only. */
export function isAllowedEgress(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return false;
  return true;
}
