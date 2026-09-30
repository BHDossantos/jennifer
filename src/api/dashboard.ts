/**
 * Minimal authenticated dashboard (spec §14 IA: Today, Conversations, Tasks,
 * Calls, Memory, Connections, Settings). The production client is React
 * Native; this page exercises the same API for the Week 2 deliverable.
 */
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Jennifer</title>
<style>
  :root { --bg:#faf8f6; --fg:#1d1a19; --muted:#6b6461; --card:#fff; --line:#e7e1dc; --accent:#8a3b54; --warn:#a4461a; --ok:#2f6b43; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141213; --fg:#f2eeeb; --muted:#a79e9a; --card:#1e1b1c; --line:#322d2e; --accent:#d58aa3; --warn:#f0a070; --ok:#7fc79a; } }
  * { box-sizing: border-box; }
  body { margin:0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:16px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--line); }
  h1 { font-size:20px; margin:0; letter-spacing:.02em; }
  nav { display:flex; gap:4px; overflow-x:auto; padding:8px 16px; border-bottom:1px solid var(--line); }
  nav button { background:none; border:0; color:var(--muted); padding:8px 12px; border-radius:999px; font:inherit; cursor:pointer; }
  nav button[aria-current="page"] { background:var(--card); color:var(--fg); box-shadow:0 0 0 1px var(--line); }
  main { padding:16px; max-width:760px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin:0 0 12px; }
  .muted { color:var(--muted); font-size:14px; }
  .bad { color:var(--warn); } .good { color:var(--ok); }
  pre { white-space:pre-wrap; word-break:break-word; font-size:14px; margin:8px 0; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
  .btn { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:8px; padding:8px 12px; font:inherit; cursor:pointer; }
  .btn.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  .btn.danger { color:var(--warn); }
  #voice { width:56px; height:56px; border-radius:50%; border:0; background:var(--accent); color:#fff; position:fixed; right:16px; bottom:16px; font-size:13px; }
  @media (prefers-reduced-motion: no-preference) { #voice[data-state="listening"] { animation: pulse 1.6s infinite; } }
  @keyframes pulse { 50% { box-shadow:0 0 0 12px color-mix(in srgb, var(--accent) 25%, transparent); } }
  input { font:inherit; padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); width:100%; }
</style>
</head>
<body>
<header><h1>Jennifer</h1><span id="status" class="muted" aria-live="polite"></span></header>
<nav aria-label="Sections">
  <button data-tab="today" aria-current="page">Today</button>
  <button data-tab="tasks">Tasks</button>
  <button data-tab="connections">Connections</button>
  <button data-tab="memory">Memory</button>
  <button data-tab="settings">Settings</button>
</nav>
<main id="view"></main>
<button id="voice" data-state="offline" aria-label="Talk to Jennifer (voice unavailable in this preview)">offline</button>
<script>
const $ = (s) => document.querySelector(s);
let token = null;
try { token = sessionStorage.getItem('jennifer_token'); } catch {}
if (!token) { token = prompt('Owner API token'); try { sessionStorage.setItem('jennifer_token', token); } catch {} }
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || body.error || r.status);
  return body;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const card = (a) => \`<div class="card"><strong>\${esc(a.type)}</strong> <span class="muted">· \${esc(a.state)}</span>
  <div class="muted">From \${esc(a.sendingAccount)} to \${esc(a.recipients.join(', '))}</div>
  \${a.subject ? '<div>' + esc(a.subject) + '</div>' : ''}<pre>\${esc(a.body)}</pre>
  \${a.attachmentIds.length ? '<div class="muted">Attachments: ' + esc(a.attachmentIds.join(', ')) + '</div>' : ''}
  <div class="muted">\${esc((a.consequences || []).join(' · '))}</div>
  \${a.state === 'awaiting_decision' ? \`<div class="row"><button class="btn primary" data-approve="\${a.id}" data-rev="\${a.revision}" data-hash="\${a.payloadHash}">Approve and send</button><button class="btn" data-cancel="\${a.id}">Decline</button></div>\` : ''}</div>\`;

const views = {
  async today() {
    const t = await api('/v1/today');
    const b = t.brief;
    return \`<div class="card"><strong>Connector health</strong>\${b.connectorHealth.map(c => \`<div class="\${c.state === 'ok' ? 'good' : 'bad'}">\${esc(c.connector)}: \${esc(c.detail)}</div>\`).join('') || '<div class="muted">No accounts connected yet.</div>'}</div>
      <h2>Needs your decision</h2>\${t.awaitingDecision.map(card).join('') || '<p class="muted">Nothing waiting.</p>'}
      <h2>Completed</h2>\${b.completed.map(c => '<div class="card">' + esc(c.summary) + '</div>').join('') || '<p class="muted">Nothing completed in the last 24 hours.</p>'}
      <h2>Blocked</h2>\${b.failures.map(f => '<div class="card bad">' + esc(f.summary) + '<div class="muted">' + esc(f.recovery) + '</div></div>').join('') || '<p class="muted">No failures.</p>'}\`;
  },
  async tasks() { return (await api('/v1/actions')).map(card).join('') || '<p class="muted">No tasks.</p>'; },
  async connections() {
    return (await api('/v1/connections')).map(c => \`<div class="card"><strong>\${esc(c.provider)}</strong> <span class="\${c.connected ? 'good' : 'bad'}">\${c.connected ? 'connected' : 'not connected'}</span>
      <div class="muted">Monitoring: \${c.canMonitor ? 'yes' : 'no'} · Last sync: \${esc(c.lastSync || 'never')}</div>
      <div>Can: \${esc(c.actions.join(', ') || 'nothing yet')}</div><div class="muted">Unavailable: \${esc(c.unavailable.join(', '))}</div>
      \${c.problem ? '<div class="bad">' + esc(c.problem) + '</div>' : ''}</div>\`).join('');
  },
  async memory() {
    return \`<div class="card"><label>Search memory <input id="mq" placeholder="e.g. travel in November"></label></div><div id="mres"></div>\`;
  },
  async settings() {
    const t = await api('/v1/today');
    return \`<div class="card"><strong>Controls</strong><pre>\${esc(JSON.stringify(t.controls, null, 2))}</pre>
      <div class="row"><button class="btn" data-ctl="pause">Pause Jennifer</button><button class="btn" data-ctl="resume">Resume</button><button class="btn danger" data-ctl="emergency-stop">Emergency stop</button></div>
      <p class="muted">Stopping cancels queued work. Messages already sent cannot reliably be unsent.</p></div>\`;
  },
};
async function show(tab) {
  document.querySelectorAll('nav button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  try { $('#view').innerHTML = await views[tab](); $('#status').textContent = ''; } catch (e) { $('#status').textContent = 'Error: ' + e.message; }
}
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset.tab) return show(t.dataset.tab);
  if (t.dataset.approve) { const r = await api('/v1/actions/' + t.dataset.approve + '/approve', { method: 'POST', body: JSON.stringify({ revision: +t.dataset.rev, payloadHash: t.dataset.hash }) }); $('#status').textContent = 'Result: ' + r.state; return show('today'); }
  if (t.dataset.cancel) { await api('/v1/actions/' + t.dataset.cancel + '/cancel', { method: 'POST', body: '{}' }); return show('today'); }
  if (t.dataset.ctl) { await api('/v1/controls/' + t.dataset.ctl, { method: 'POST', body: '{}' }); return show('settings'); }
});
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'mq') return;
  const res = await api('/v1/memory?q=' + encodeURIComponent(e.target.value));
  $('#mres').innerHTML = res.map(r => \`<div class="card">\${esc(r.entry.value)}<div class="muted">\${esc(r.freshness)} · source \${esc(r.sourceRef)}</div></div>\`).join('') || '<p class="muted">No matching memory.</p>';
});
show('today');
</script>
</body>
</html>`;
