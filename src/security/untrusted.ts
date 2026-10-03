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
  // Patterns below adapted from OpenJarvis security/injection_scanner.py (Apache-2.0); see THIRD_PARTY_LICENSES.
  ['identity_override', /\byou\s+are\s+now\s+(?:a\s+)?(?:different|new|my)\b/i],
  ['code_injection', /\b(?:execute|run|eval)\s*\(\s*['"]/i],
  ['shell_injection', /(?:;|\||&&)\s*(?:rm|curl|wget|nc|ncat|bash|sh|python|perl)\s/],
  ['exfiltration_url', /\b(?:send|post|upload|exfiltrate|transmit)\s+(?:(?:to|data|all|everything)\s+)*(?:to\s+)?(?:https?:\/\/|my\s+server)/i],
  ['encoded_exfiltration', /\bbase64\s+encode\s+(?:and\s+)?(?:send|include|append)/i],
  ['jailbreak', /\b(?:DAN|do\s+anything\s+now)\s+(?:mode|prompt|jailbreak)|\bpretend\s+(?:you\s+)?(?:have\s+)?no\s+(?:restrictions?|limitations?|rules?|filters?)/i],
  ['delimiter_injection', /```(?:system|assistant)\b|<\|(?:im_start|im_end|system|assistant)\|>/i],
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
  if (u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') return false;
  return !isPrivateAddress(h);
}

/** True for loopback, private, link-local, CGNAT/metadata and unspecified addresses (IPv4, IPv6, IPv4-mapped IPv6). */
export function isPrivateAddress(host: string): boolean {
  let h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) h = mapped[1]!;
  const hexMapped = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hexMapped) {
    const a = parseInt(hexMapped[1]!, 16), b = parseInt(hexMapped[2]!, 16);
    h = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(':')) return h === '::' || h === '::1' || /^0*(:0*)*:?0*1?$/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || /^ff/.test(h);
  return false;
}

/**
 * Fetch a third-party URL safely: the host must resolve only to public
 * addresses (checked per hop), redirects are followed manually and
 * re-checked, and the body is capped while streaming.
 */
export async function safeFetchText(url: string, opts: { headers?: Record<string, string>; maxBytes?: number; maxRedirects?: number; fetchImpl?: typeof fetch; resolve?: (host: string) => Promise<string[]> } = {}): Promise<{ status: number; text: string }> {
  const resolve = opts.resolve ?? (async (host: string) => (await (await import('node:dns')).promises.lookup(host, { all: true })).map((a) => a.address));
  let current = url;
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    if (!isAllowedEgress(current)) throw new Error('destination is not allowed');
    const host = new URL(current).hostname.replace(/^\[|\]$/g, '');
    if (!/^[\d.]+$/.test(host) && !host.includes(':')) {
      const addrs = await resolve(host);
      if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new Error('destination resolves to a private address');
    }
    const res = await (opts.fetchImpl ?? fetch)(current, { headers: opts.headers, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current).toString();
      continue;
    }
    const max = opts.maxBytes ?? 5 * 1024 * 1024;
    if (!res.body) return { status: res.status, text: '' };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw new Error('response is too large');
      }
      chunks.push(value);
    }
    return { status: res.status, text: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('too many redirects');
}
