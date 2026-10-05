import { readFileSync } from 'node:fs';
const src = readFileSync('src/api/server.ts', 'utf8') + '\n// ---- Company OS ----\n' + readFileSync('src/api/companyRoutes.ts', 'utf8');
const lines = src.split('\n');
const out: string[] = ['| Method | Path | Auth | Notes |', '|---|---|---|---|'];
let lastComment = '';
let section = '';
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]!;
  const sec = /\/\/ ---- (.+?) -{3,}/.exec(l);
  if (sec) { section = sec[1]!.trim(); out.push(`\n### ${section}\n\n| Method | Path | Auth | Notes |\n|---|---|---|---|`); continue; }
  const doc = /\/\*\*\s*(.+?)\s*\*\//.exec(l);
  if (doc) lastComment = doc[1]!;
  const m = /app\.(get|post|put|delete)\('([^']+)',\s*(\{[^}]*\}|owner|anyone|async)/.exec(l);
  if (m) {
    const auth = m[3] === 'owner' || m[3]!.includes('owner') ? 'owner' : m[3] === 'anyone' ? 'owner, developer, operator' : m[3]!.includes('clipAuth') ? 'owner or clip token' : (m[2]!.includes('webhooks') ? 'provider signature' : m[2]!.includes('/auth/passkeys/login') ? 'public (passkey challenge)' : 'public');
    out.push(`| ${m[1]!.toUpperCase()} | \`${m[2]}\` | ${auth} | ${lastComment.replace(/\|/g, '/')} |`);
    lastComment = '';
  } else if (!doc && l.trim() && !l.trim().startsWith('*') && !l.trim().startsWith('//')) {
    lastComment = '';
  }
}
process.stdout.write(out.join('\n') + '\n');
