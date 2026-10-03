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
<meta name="theme-color" content="#141213" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Jennifer" />
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
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
  input, textarea, select { font:inherit; padding:8px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); width:100%; }
</style>
</head>
<body>
<header><h1>Jennifer</h1><span><span id="status" class="muted" aria-live="polite"></span> <button class="btn" id="signin">Sign in with passkey</button></span></header>
<nav aria-label="Sections">
  <button data-tab="today" aria-current="page">Today</button>
  <button data-tab="ask">Ask</button>
  <button data-tab="missions">Missions</button>
  <button data-tab="conversations">Inbox</button>
  <button data-tab="tasks">Tasks</button>
  <button data-tab="calls">Calls</button>
  <button data-tab="connections">Connections</button>
  <button data-tab="memory">Memory</button>
  <button data-tab="voice">Voice</button>
  <button data-tab="settings">Settings</button>
</nav>
<main id="view"></main>
<button id="voice" data-state="offline" aria-label="Talk to Jennifer">Talk</button>
<script>
const $ = (s) => document.querySelector(s);
let token = null;
try { token = sessionStorage.getItem('jennifer_token'); } catch {}
const saveToken = (t) => { token = t; try { sessionStorage.setItem('jennifer_token', t); } catch {} };
// WebAuthn helpers: the server speaks base64url JSON; the browser needs ArrayBuffers.
const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).split('+').join('-').split('/').join('_').replace(/=+$/, '');
const credJSON = (c) => ({ id: c.id, rawId: bufToB64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(),
  response: Object.fromEntries(['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle'].filter((k) => c.response[k]).map((k) => [k, bufToB64u(c.response[k])])) });
async function passkeyGet(o) {
  return credJSON(await navigator.credentials.get({ publicKey: { ...o, challenge: b64uToBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) } }));
}
async function passkeyCreate(o) {
  return credJSON(await navigator.credentials.create({ publicKey: { ...o, challenge: b64uToBuf(o.challenge), user: { ...o.user, id: b64uToBuf(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) } }));
}
async function signIn() {
  const o = await fetch('/v1/auth/passkeys/login/options', { method: 'POST' }).then((r) => r.json());
  if (!o.handle) { const t = prompt('No passkey yet. Enter the bootstrap owner token to register this device:'); if (t) { saveToken(t); await registerDevice(); } return; }
  const r = await fetch('/v1/auth/passkeys/login/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: o.handle, response: await passkeyGet(o.options) }) }).then((r) => r.json());
  if (r.token) { saveToken(r.token); show('today'); }
}
async function registerDevice() {
  const o = await api('/v1/auth/passkeys/register/options', { method: 'POST', body: '{}' });
  await api('/v1/auth/passkeys/register/verify', { method: 'POST', body: JSON.stringify({ handle: o.handle, response: await passkeyCreate(o.options), device: { platform: navigator.platform || 'web', label: 'Browser' } }) });
  await signIn();
}
async function stepUp() {
  const o = await api('/v1/auth/step-up/options', { method: 'POST', body: '{}' });
  await api('/v1/auth/step-up/verify', { method: 'POST', body: JSON.stringify({ handle: o.handle, response: await passkeyGet(o.options) }) });
}
const api = async (path, opts = {}, retried = false) => {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  // Sensitive changes ask for a fresh passkey confirmation; do it once and retry.
  if (!r.ok && body.error === 'approval.step_up_required' && !retried && !path.startsWith('/v1/auth/step-up')) { await stepUp(); return api(path, opts, true); }
  if (!r.ok) throw new Error(body.message || body.error || r.status);
  return body;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const LABEL = { send_message: 'Email', create_event: 'New calendar event', modify_event: 'Calendar change' };
const STATE = { awaiting_decision: 'waiting for you', provider_accepted: 'sent', confirmed: 'done', ready: 'about to run', canceled: 'canceled', failed: 'failed', unknown: 'checking whether it went out' };
const card = (a) => \`<div class="card"><strong>\${esc(LABEL[a.type] || a.type)}</strong> <span class="muted">· \${esc(STATE[a.state] || a.state)}</span>
  <div class="muted">From \${esc(a.sendingAccount)} to \${esc(a.recipients.join(', '))}</div>
  \${a.subject ? '<div>' + esc(a.subject) + '</div>' : ''}<pre>\${esc(a.body)}</pre>
  \${a.attachmentIds.length ? '<div class="muted">Attachments: ' + esc(a.attachmentIds.join(', ')) + '</div>' : ''}
  <div class="muted">\${esc((a.consequences || []).join(' · '))}</div>
  \${a.state === 'awaiting_decision' ? \`<div class="row"><button class="btn primary" data-approve="\${a.id}" data-rev="\${a.revision}" data-hash="\${a.payloadHash}">Approve and send</button><button class="btn" data-edit="\${a.id}">Edit</button>
    <select style="width:auto" data-why="\${a.id}" aria-label="Why decline"><option value="rejected">Decline</option><option value="wrong_fact">Decline: wrong fact</option><option value="wrong_recipient">Decline: wrong recipient</option><option value="poor_tone">Decline: wrong tone</option><option value="incomplete_action">Decline: incomplete</option></select><button class="btn" data-cancel="\${a.id}">Decline</button></div>
    <div id="edit-\${a.id}" hidden><label>Subject <input id="es-\${a.id}" value="\${esc(a.subject || '')}"></label><label>Message <textarea id="eb-\${a.id}" rows="8">\${esc(a.body || '')}</textarea></label>
    <p class="muted">Saving creates a new version; you then approve that exact version.</p><button class="btn primary" data-saveedit="\${a.id}">Save changes</button></div>\` : ''}\${a.receipt ? '<div class="good">Receipt: ' + esc(a.receipt.evidence || a.receipt.deliveryStatus || '') + '</div>' : ''}</div>\`;

const views = {
  async today() {
    const t = await api('/v1/today');
    const ob = await api('/v1/onboarding').catch(() => ({ remaining: 0, steps: [] }));
    const setup = ob.remaining ? \`<div class="card"><strong>Get started</strong> <span class="muted">· \${ob.remaining} step\${ob.remaining > 1 ? 's' : ''} left</span>
      \${ob.steps.map((s) => \`<div class="\${s.done ? 'good' : s.optional ? 'muted' : ''}">\${s.done ? '✓' : '○'} \${s.tab && !s.done ? \`<a href="#" data-tab="\${s.tab}">\${esc(s.title)}</a>\` : esc(s.title)}</div>\`).join('')}</div>\` : '';
    const todayCal = (t.brief.today || []).length ? '<div class="card"><strong>Today</strong>' + t.brief.today.map((e) => '<div>' + esc(e.time) + ' · ' + esc(e.title) + '</div>').join('') + '</div>' : '';
    const b = t.brief;
    return setup + todayCal + \`<div class="card"><strong>Connector health</strong>\${b.connectorHealth.map(c => \`<div class="\${c.state === 'ok' ? 'good' : 'bad'}">\${esc(c.connector)}: \${esc(c.detail)}</div>\`).join('') || '<div class="muted">No accounts connected yet.</div>'}</div>
      <h2>Needs your decision</h2>\${t.awaitingDecision.map(card).join('') || '<p class="muted">Nothing waiting.</p>'}
      <h2>Completed</h2>\${b.completed.map(c => '<div class="card">' + esc(c.summary) + '</div>').join('') || '<p class="muted">Nothing completed in the last 24 hours.</p>'}
      <h2>Blocked</h2>\${b.failures.map(f => '<div class="card bad">' + esc(f.summary) + '<div class="muted">' + esc(f.recovery) + '</div></div>').join('') || '<p class="muted">No failures.</p>'}\`;
  },
  async conversations() {
    if (convOpen) {
      const d = await api('/v1/conversations/' + encodeURIComponent(convOpen));
      const items = d.messages.map((m) => ({ at: m.at, html: \`<div class="card \${m.direction === 'outbound' ? 'good' : ''}"><div class="muted">\${esc(m.direction === 'outbound' ? 'You' : (m.from.displayName || m.from.address))} · \${esc(new Date(m.at).toLocaleString())}\${(m.flags || []).length ? ' · ' + esc(m.flags.join(', ')) : ''}</div><pre>\${esc(m.body)}</pre>\${m.attachments.map((a) => '<div class="muted">📎 ' + esc(a.filename) + ' (' + esc(a.scanStatus) + ')</div>').join('')}</div>\` }));
      return \`<button class="btn" data-conv="">← All conversations</button><h2>\${esc(d.conversation.subject || '(no subject)')}</h2><div class="muted">\${esc(d.conversation.space)} · \${esc(d.conversation.accountId)}</div>\` + items.map((i) => i.html).join('') + (d.actions.length ? '<h3>Drafts and actions</h3>' + d.actions.map(card).join('') : '');
    }
    const list = await api('/v1/conversations');
    return list.map((c) => \`<div class="card" role="button" tabindex="0" data-conv="\${esc(c.id)}"><strong data-conv="\${esc(c.id)}">\${esc(c.subject || '(no subject)')}</strong> <span class="muted">\${esc(c.space)}\${c.pendingActions ? ' · ' + c.pendingActions + ' waiting' : ''}</span><div class="muted" data-conv="\${esc(c.id)}">\${esc((c.lastFrom && (c.lastFrom.displayName || c.lastFrom.address)) || '')}: \${esc(c.lastPreview || '')}</div></div>\`).join('') || '<p class="muted">No conversations yet. Connect Gmail in Connections.</p>';
  },
  async tasks() { return (await api('/v1/actions')).map(card).join('') || '<p class="muted">No tasks.</p>'; },
  async connections() {
    const g = await api('/v1/connectors/gmail').catch(() => ({}));
    const gmailCard = \`<div class="card"><strong>Your Gmail</strong> <span class="muted">\${esc(g.address ? g.address + ' · ' + (g.worker?.state || '') : 'not connected')}</span>
      <p class="muted">Google Account → Security → 2-Step Verification → App passwords → create one named "Jennifer". Paste it here once; it is stored encrypted and never shown again.</p>
      <label>Gmail address <input id="gaddr" type="email" autocomplete="username" placeholder="you@gmail.com"></label>
      <label>App password <input id="gpass" type="password" autocomplete="off" placeholder="xxxx xxxx xxxx xxxx"></label>
      <div class="row"><button class="btn primary" data-gmail="connect">Connect Gmail</button><button class="btn" data-gmail="sync">Check now</button><button class="btn" data-gmail="import">Import last 7 days</button><button class="btn danger" data-gmail="disconnect">Disconnect</button></div></div>\`;
    const cal = await api('/v1/connectors/calendar').catch(() => ({ calendars: [] }));
    const calCard = \`<div class="card"><strong>Calendars</strong> <span class="muted">\${esc(cal.calendars.map((c) => c.label + (c.writable ? '' : ' (read-only)')).join(', ') || 'none connected')}</span>
      <p class="muted"><b>iCloud</b> (read and write): appleid.apple.com → Sign-In and Security → App-Specific Passwords → generate "Jennifer".</p>
      <label>Apple ID <input id="capple" type="email" autocomplete="username"></label>
      <label>App-specific password <input id="cpass" type="password" autocomplete="off" placeholder="xxxx-xxxx-xxxx-xxxx"></label>
      <div class="row"><button class="btn primary" data-cal="icloud">Connect iCloud Calendar</button></div>
      <p class="muted"><b>Google Calendar</b> (read-only): Google Calendar → Settings → your calendar → Integrate calendar → Secret address in iCal format.</p>
      <label>Secret iCal address <input id="cfeed" type="url" autocomplete="off"></label>
      <div class="row"><button class="btn" data-cal="feed">Add Google Calendar</button><button class="btn" data-cal="sync">Refresh now</button></div></div>\`;
    return gmailCard + calCard + (await api('/v1/connections')).map(c => \`<div class="card"><strong>\${esc(c.provider)}</strong> <span class="\${c.connected ? 'good' : 'bad'}">\${c.connected ? 'connected' : 'not connected'}</span>
      <div class="muted">Monitoring: \${c.canMonitor ? 'yes' : 'no'} · Last sync: \${esc(c.lastSync || 'never')}</div>
      <div>Can: \${esc(c.actions.join(', ') || 'nothing yet')}</div><div class="muted">Unavailable: \${esc(c.unavailable.join(', '))}</div>
      \${c.problem ? '<div class="bad">' + esc(c.problem) + '</div>' : ''}</div>\`).join('');
  },
  async memory() {
    const [pending, imports] = await Promise.all([api('/v1/memory/pending'), api('/v1/history/imports').catch(() => [])]);
    const review = pending.length ? '<h3>Waiting for your OK</h3>' + pending.map((m) => \`<div class="card">\${esc(m.value)}<div class="muted">\${esc(m.kind)} · from \${esc(m.source.kind)}\${m.source.excerpt ? ': “' + esc(m.source.excerpt.slice(0, 140)) + '”' : ''}</div><button data-memact="\${m.id}|activate">Remember</button> <button data-memact="\${m.id}|delete">Discard</button></div>\`).join('') : '';
    const imp = imports.map((i) => \`<li>\${esc(i.source)} · \${i.conversations} chats, \${i.messages} messages\${i.projects ? ', ' + i.projects + ' projects' : ''} · <button data-histdel="\${i.id}">Remove</button></li>\`).join('');
    return review + \`<div class="card"><label>Search memory <input id="mq" placeholder="e.g. travel in November"></label><button class="btn" data-memexport="1">Export all memory</button></div><div id="mres"></div>
      <h3>ChatGPT &amp; Claude history</h3>
      <div class="card"><p class="muted">Jennifer reads only what you give her: your data export (ChatGPT → Settings → Data controls → Export data; Claude → Settings → Privacy → Export data), or a single chat you share. She never signs in to those accounts.</p>
        <label>Upload export (.zip or conversations.json) <input type="file" id="histfile" accept=".zip,.json,application/zip,application/json"></label>
        <label>Search your AI chats <input id="hq" placeholder="e.g. agency business plan"></label><div id="hres"></div>
        <details><summary>Paste a chat (Send to Jennifer)</summary><textarea id="clip" rows="5" placeholder="Paste a ChatGPT or Claude conversation"></textarea>
          <select id="clipfrom"><option value="chatgpt">ChatGPT</option><option value="claude">Claude</option><option value="other">Other</option></select> <button data-clip="1">Save</button>
          <p class="muted">For the iPhone Share Sheet, make a Shortcut that POSTs the shared text to /v1/history/clip with this token in the X-Jennifer-Clip-Token header.</p><button data-cliptoken="1">Create Share Sheet token</button> <code id="cliptok"></code></details>
        \${imp ? '<ul>' + imp + '</ul>' : ''}</div>\`;
  },
  async calls() {
    const r = await api('/v1/calls');
    if (!r.configured && r.calls.length === 0) return '<div class="card muted">Phone calls are not set up yet. Jennifer needs a phone number (SignalWire or Twilio) pointed at OpenAI, plus OPENAI_WEBHOOK_SECRET. See the README.</div>';
    return r.calls.map((c) => \`<div class="card"><strong>\${esc(c.callerIdHint || c.from || 'Unknown caller')}</strong> <span class="muted">· \${esc(new Date(c.startedAt).toLocaleString())} · \${esc(c.outcome || 'in progress')}</span>
      \${c.messages.map((m) => \`<div class="card \${m.urgent ? 'bad' : ''}"><div>\${esc(m.text)}</div><div class="muted">\${esc(m.name || '')} \${esc(m.callbackNumber || '')}</div></div>\`).join('')}
      <details><summary class="muted">Call log</summary>\${c.events.map((e) => '<div class="muted">' + esc(new Date(e.at).toLocaleTimeString()) + ' · ' + esc(e.text) + '</div>').join('')}</details></div>\`).join('') || '<p class="muted">No calls yet.</p>';
  },
  async ask() {
    const bubbles = chatLog.map((m) => \`<div class="card" style="\${m.who === 'you' ? 'margin-left:15%' : 'margin-right:15%'}"><div class="muted">\${m.who === 'you' ? 'You' : 'Jennifer'}</div><div style="white-space:pre-wrap">\${esc(m.text)}</div></div>\`).join('');
    return \`\${bubbles || '<p class="muted">Ask about your day, your inbox or your missions, or tell Jennifer something to remember.</p>'}
      <div class="card"><label>Message <input id="chatin" placeholder="e.g. What needs my attention today?" autocomplete="off"></label>
      <div class="row"><button class="btn primary" data-chat="send">Send</button><button class="btn" data-chat="new">New conversation</button></div></div>\`;
  },
  async missions() {
    const { missions, presets } = await api('/v1/missions');
    const autonomyLabel = { act: 'acts on its own', act_if_preapproved: 'acts for pre-approved contacts', ask: 'asks you first', hand_over: 'hands it to you' };
    const sched = (s) => s.kind === 'interval' ? 'every ' + s.minutes + ' min' : s.kind === 'daily' ? 'daily at ' + s.localTime : 'when you ask';
    const cards = missions.filter((m) => m.status !== 'archived').map((m) => \`<div class="card"><strong>\${esc(m.title)}</strong> <span class="muted">· \${esc(m.status)} · \${esc(sched(m.schedule))}</span>
      <div class="muted">\${esc(m.goal)}</div>
      <div class="muted">Sending email: \${esc(autonomyLabel[(m.autonomy || {}).send_email || 'ask'])}</div>
      \${(m.results || []).filter((r) => r.status === 'new').slice(0, 3).map((r) => \`<div class="card"><div class="muted">\${esc(new Date(r.at).toLocaleString())}</div><pre>\${esc(r.body)}</pre>
        <div class="row"><button class="btn" data-mresult="\${m.id}|\${r.id}|reviewed">Got it</button><button class="btn" data-mresult="\${m.id}|\${r.id}|dismissed">Dismiss</button></div></div>\`).join('')}
      <details><summary class="muted">Activity</summary>\${(m.activity || []).slice(-12).reverse().map((a) => '<div class="muted">' + esc(new Date(a.at).toLocaleTimeString()) + ' · ' + esc(a.text) + '</div>').join('')}</details>
      <div class="row"><button class="btn primary" data-mission="\${m.id}|run">Run now</button>
      \${m.status === 'active' ? \`<button class="btn" data-mission="\${m.id}|pause">Pause</button>\` : \`<button class="btn" data-mission="\${m.id}|resume">Resume</button>\`}
      <button class="btn danger" data-mission="\${m.id}|archive">Remove</button></div></div>\`).join('') || '<p class="muted">No missions yet.</p>';
    const presetButtons = presets.map((p) => \`<button class="btn" data-preset="\${p.id}">\${esc(p.title)}</button>\`).join('');
    return \`<p class="muted">Missions keep working in the background. Background checks only read; anything they want to send follows the permission you set.</p>\${cards}
      <div class="card"><strong>Start a mission</strong><div class="row">\${presetButtons}</div>
      <label>Name <input id="mtitle" placeholder="e.g. Concert bookings"></label>
      <label>Goal <input id="mgoal" placeholder="What should Jennifer keep working on?"></label>
      <label>Check every <select id="msched"><option value="manual">only when I ask</option><option value="30">30 minutes</option><option value="60">hour</option><option value="240">4 hours</option></select></label>
      <label>Sending email <select id="mauto"><option value="ask">ask me first</option><option value="hand_over">hand it to me</option><option value="act_if_preapproved">act for pre-approved contacts</option><option value="act">act on its own (verified contacts)</option></select></label>
      <div class="row"><button class="btn primary" data-newmission="1">Create mission</button></div></div>\`;
  },
  async voice() {
    const v = await api('/v1/voice');
    const s = v.settings;
    const cards = v.candidates.map((c) => \`<div class="card"><strong>\${esc(c.label)}</strong> \${s.voiceId === c.id ? '<span class="good">· Jennifer\\u2019s voice</span>' : ''}
      <div class="muted">\${esc(c.character)}</div>
      <div class="row"><button class="btn" data-audition="\${c.id}" data-mode="private">Play private</button><button class="btn" data-audition="\${c.id}" data-mode="business">Play business</button>
      <button class="btn primary" data-choose="\${c.id}">Choose</button></div></div>\`).join('');
    const slider = (k, min, max, step) => \`<label>\${k} <input type="range" data-voiceset="\${k}" min="\${min}" max="\${max}" step="\${step}" value="\${s[k]}"></label>\`;
    return (v.configured ? '' : '<div class="card bad">Voice needs OPENAI_API_KEY on the server.</div>') +
      '<p class="muted">Listen to each voice and choose Jennifer\\u2019s. Private mode is how she speaks to you; business mode is how she sounds to everyone else.</p>' + cards +
      \`<div class="card"><strong>Delivery</strong>\${slider('warmth', 0, 1, 0.1)}\${slider('playfulness', 0, 1, 0.1)}\${slider('speakingRate', 0.75, 1.25, 0.05)}
      <label>Mode <select data-voiceset="mode"><option value="private" \${s.mode === 'private' ? 'selected' : ''}>Private (with you)</option><option value="business" \${s.mode === 'business' ? 'selected' : ''}>Business</option></select></label></div>\`;
  },
  async settings() {
    const t = await api('/v1/today');
    const np = await api('/v1/notifications/prefs');
    const notif = \`<div class="card"><strong>Notifications</strong>
      <p class="muted">On iPhone, notifications work once Jennifer is on your Home Screen (Share → Add to Home Screen).</p>
      <div class="row"><button class="btn primary" data-push="enable">Turn on notifications</button><button class="btn" data-push="test">Send a test</button></div>
      <label>Quiet from <input type="time" data-pref="quietStart" value="\${np.quietStart}"></label>
      <label>until <input type="time" data-pref="quietEnd" value="\${np.quietEnd}"></label>
      <label><input type="checkbox" data-pref="showDetails" \${np.showDetails ? 'checked' : ''}> Show details on the lock screen</label></div>\`;
    const [contacts, conns, fb, dlq] = await Promise.all([api('/v1/contacts').catch(() => []), api('/v1/connections').catch(() => []), api('/v1/feedback').catch(() => ({ rules: [] })), api('/v1/dead-letters').catch(() => [])]);
    const ctl = t.controls;
    const state = ctl.emergencyStop ? '<span class="bad">Emergency stop is on</span>' : ctl.globalPaused ? '<span class="bad">Paused</span>' : '<span class="good">Running</span>';
    const connPause = conns.filter((c) => c.connected).map((c) => { const p = ctl.pausedConnectors.includes(c.id); return \`<div>\${esc(c.provider)} <button class="btn" data-pausec="\${esc(c.id)}|\${p ? 'resume' : 'pause'}">\${p ? 'Resume' : 'Pause'}</button></div>\`; }).join('');
    const contactPause = contacts.map((c) => \`<div>\${esc(c.name)} <span class="muted">\${esc(c.identities.map((i) => i.value).join(', '))}</span> <button class="btn" data-pausek="\${esc(c.id)}|\${c.paused ? 'resume' : 'pause'}">\${c.paused ? 'Resume' : 'Pause'}</button></div>\`).join('') || '<div class="muted">No contacts yet.</div>';
    const rules = fb.rules.map((r) => \`<div class="card">\${esc(r.rule)} <span class="muted">· \${esc(r.impact)} · \${esc(r.status)}</span>\${r.status === 'proposed' || r.status === 'auto_applied' ? \`<div class="row"><button class="btn" data-rule="\${esc(r.id)}|approved">Keep</button><button class="btn" data-rule="\${esc(r.id)}|rejected">Drop</button></div>\` : ''}</div>\`).join('') || '<p class="muted">No learned rules yet. Jennifer proposes one after repeated corrections.</p>';
    const problems = dlq.map((d) => \`<div class="card bad">\${esc(d.kind)}: \${esc(d.error)}<div class="muted">\${esc(d.recoveryAction)}</div><div class="row"><button class="btn" data-dlq="\${esc(d.id)}|retry">Try again (asks you first)</button><button class="btn" data-dlq="\${esc(d.id)}|dismiss">Dismiss</button></div></div>\`).join('');
    return (problems ? '<h2>Problems</h2>' + problems : '') + \`<div class="card"><strong>Controls</strong> \${state}
      <div class="row"><button class="btn" data-ctl="pause">Pause Jennifer</button><button class="btn" data-ctl="resume">Resume</button><button class="btn danger" data-ctl="emergency-stop">Emergency stop</button></div>
      <p class="muted">Stopping cancels queued work. Messages already sent cannot reliably be unsent.</p>
      <details><summary>Pause one account</summary>\${connPause || '<div class="muted">No connected accounts.</div>'}</details>
      <details><summary>Pause one contact</summary>\${contactPause}</details></div>
      <h2>What Jennifer learned</h2>\${rules}\` + notif;
  },
};
let current = 'today';
let convOpen = null;
async function show(tab) {
  current = tab;
  document.querySelectorAll('nav button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  try { $('#view').innerHTML = await views[tab](); if (/^Error/.test($('#status').textContent)) $('#status').textContent = ''; } catch (e) { $('#status').textContent = 'Error: ' + e.message; }
}
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset.tab) { if (t.dataset.tab === 'conversations') convOpen = null; return show(t.dataset.tab); }
  if (t.id === 'signin') return signIn().catch((err) => { $('#status').textContent = 'Sign-in failed: ' + err.message; });
  if (t.dataset.approve) { const go = () => api('/v1/actions/' + t.dataset.approve + '/approve', { method: 'POST', body: JSON.stringify({ revision: +t.dataset.rev, payloadHash: t.dataset.hash }) });
    let r; try { r = await go(); } catch (err) { if (!/second-factor/.test(err.message)) throw err; await stepUp(); r = await go(); }
    $('#status').textContent = 'Result: ' + r.state; return show(current); }
  if (t.dataset.cancel) { const w = document.querySelector('[data-why="' + t.dataset.cancel + '"]'); await api('/v1/actions/' + t.dataset.cancel + '/cancel', { method: 'POST', body: JSON.stringify({ reason: w ? w.value : 'rejected' }) }); return show(current); }
  if (t.dataset.edit) { const el = $('#edit-' + t.dataset.edit); el.hidden = !el.hidden; return; }
  if (t.dataset.saveedit) {
    const id = t.dataset.saveedit; const a = await api('/v1/actions/' + id);
    const payload = { ...a.payloadRaw, subject: $('#es-' + id).value, body: $('#eb-' + id).value };
    try { await api('/v1/actions/' + id + '/edit', { method: 'POST', body: JSON.stringify({ payload }) }); $('#status').textContent = 'Saved. Review and approve the new version.'; } catch (err) { $('#status').textContent = 'Edit: ' + err.message; }
    return show(current);
  }
  if (t.dataset.conv !== undefined) { convOpen = t.dataset.conv || null; return show('conversations'); }
  if (t.dataset.pausec) { const [id, op] = t.dataset.pausec.split('|'); await api('/v1/controls/' + op, { method: 'POST', body: JSON.stringify({ connectorId: id }) }); return show('settings'); }
  if (t.dataset.pausek) { const [id, op] = t.dataset.pausek.split('|'); await api('/v1/controls/' + op, { method: 'POST', body: JSON.stringify({ contactId: id }) }); return show('settings'); }
  if (t.dataset.rule) { const [id, st] = t.dataset.rule.split('|'); await api('/v1/feedback/rules/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify({ status: st }) }); return show('settings'); }
  if (t.dataset.dlq) { const [id, op] = t.dataset.dlq.split('|'); try { await api('/v1/dead-letters/' + id + '/' + op, { method: 'POST', body: '{}' }); } catch (err) { $('#status').textContent = err.message; } return show(op === 'retry' ? 'today' : 'settings'); }
  if (t.dataset.memfix) { const v = prompt('What is correct?'); if (v) { await api('/v1/memory/' + t.dataset.memfix + '/correct', { method: 'POST', body: JSON.stringify({ value: v }) }); $('#status').textContent = 'Corrected. The old entry is kept as superseded.'; } return; }
  if (t.dataset.memexport) {
    const data = await api('/v1/memory/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'jennifer-memory.json'; link.click(); URL.revokeObjectURL(url); return;
  }
  if (t.id === 'voice') return rtc ? stopVoice() : startVoice().catch((err) => { stopVoice(); $('#status').textContent = 'Voice: ' + err.message; });
  if (t.dataset.audition) {
    t.disabled = true;
    try {
      const r = await fetch('/v1/voice/audition?voice=' + t.dataset.audition + '&mode=' + t.dataset.mode + '&lang=' + voiceLang(), { headers: { authorization: 'Bearer ' + token } });
      if (!r.ok) throw new Error((await r.json()).message || r.status);
      const a = new Audio(URL.createObjectURL(await r.blob())); await a.play();
    } catch (err) { $('#status').textContent = 'Audition: ' + err.message; } finally { t.disabled = false; }
    return;
  }
  if (t.dataset.choose) { await api('/v1/voice/settings', { method: 'PUT', body: JSON.stringify({ voiceId: t.dataset.choose }) }); return show('voice'); }
  if (t.dataset.push === 'enable') {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('add Jennifer to your Home Screen first');
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('permission not granted');
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api('/v1/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBuf(publicKey) });
      await api('/v1/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON(), label: navigator.platform || 'device' }) });
      $('#status').textContent = 'Notifications are on';
    } catch (err) { $('#status').textContent = 'Notifications: ' + err.message; }
    return;
  }
  if (t.dataset.push === 'test') { const r = await api('/v1/push/test', { method: 'POST', body: '{}' }); $('#status').textContent = 'Test: ' + r.result; return; }
  if (t.dataset.chat === 'new') { chatSession = null; chatLog = []; return show('ask'); }
  if (t.dataset.chat === 'send') {
    const text = $('#chatin').value.trim(); if (!text) return;
    chatLog.push({ who: 'you', text }); await show('ask');
    $('#status').textContent = 'Jennifer is thinking…';
    try {
      const r = await api('/v1/chat', { method: 'POST', body: JSON.stringify({ sessionId: chatSession || undefined, message: text }) });
      chatSession = r.sessionId;
      let reply = r.reply;
      if (r.remembered.length) reply += '\\n\\n(Remembered: ' + r.remembered.join('; ') + ')';
      if (r.pendingReview.length) reply += '\\n\\n(Waiting for your review before I remember: ' + r.pendingReview.join('; ') + ')';
      chatLog.push({ who: 'jennifer', text: reply });
      $('#status').textContent = '';
    } catch (err) { $('#status').textContent = 'Chat: ' + err.message; }
    return show('ask');
  }
  if (t.dataset.preset) { await api('/v1/missions', { method: 'POST', body: JSON.stringify({ preset: t.dataset.preset }) }); return show('missions'); }
  if (t.dataset.newmission) {
    const sv = $('#msched').value;
    await api('/v1/missions', { method: 'POST', body: JSON.stringify({ title: $('#mtitle').value, goal: $('#mgoal').value, schedule: sv === 'manual' ? { kind: 'manual' } : { kind: 'interval', minutes: Number(sv) }, autonomy: { send_email: $('#mauto').value } }) }).catch((err) => { $('#status').textContent = 'Mission: ' + err.message; });
    return show('missions');
  }
  if (t.dataset.mission) {
    const [id, op] = t.dataset.mission.split('|');
    t.disabled = true; $('#status').textContent = op === 'run' ? 'Mission running…' : '';
    try { await api('/v1/missions/' + id + '/' + op, { method: 'POST', body: '{}' }); $('#status').textContent = ''; } catch (err) { $('#status').textContent = 'Mission: ' + err.message; }
    return show('missions');
  }
  if (t.dataset.mresult) { const [id, rid, st] = t.dataset.mresult.split('|'); await api('/v1/missions/' + id + '/results/' + rid, { method: 'POST', body: JSON.stringify({ status: st }) }); return show('missions'); }
  if (t.dataset.cal) {
    const go = () => t.dataset.cal === 'icloud' ? api('/v1/connectors/icloud-calendar/connect', { method: 'POST', body: JSON.stringify({ appleId: $('#capple').value, appPassword: $('#cpass').value }) })
      : t.dataset.cal === 'feed' ? api('/v1/connectors/calendar-feed/connect', { method: 'POST', body: JSON.stringify({ url: $('#cfeed').value }) })
      : api('/v1/connectors/calendar/sync', { method: 'POST', body: '{}' });
    try { await go(); } catch (err) { if (!/passkey/.test(err.message)) { $('#status').textContent = 'Calendar: ' + err.message; return; } await stepUp(); await go(); }
    $('#status').textContent = 'Calendar: done';
    return show('connections');
  }
  if (t.dataset.gmail) {
    const go = async () => {
      if (t.dataset.gmail === 'connect') return api('/v1/connectors/gmail/connect', { method: 'POST', body: JSON.stringify({ address: $('#gaddr').value, appPassword: $('#gpass').value }) });
      return api('/v1/connectors/gmail/' + t.dataset.gmail, { method: 'POST', body: '{}' });
    };
    try { await go(); } catch (err) { if (!/passkey/.test(err.message)) { $('#status').textContent = 'Gmail: ' + err.message; return; } await stepUp(); await go(); }
    $('#status').textContent = 'Gmail: done';
    return show('connections');
  }
  if (t.dataset.memact) {
    const [id, op] = t.dataset.memact.split('|');
    await api(op === 'activate' ? '/v1/memory/' + id + '/activate' : '/v1/memory/' + id, { method: op === 'activate' ? 'POST' : 'DELETE', body: op === 'activate' ? '{}' : undefined });
    return show('memory');
  }
  if (t.dataset.histdel) { if (confirm('Remove this import from Jennifer?')) await api('/v1/history/imports/' + t.dataset.histdel, { method: 'DELETE' }); return show('memory'); }
  if (t.dataset.cliptoken) { const r = await api('/v1/history/clip-token', { method: 'POST', body: '{}' }); $('#cliptok').textContent = r.token; return; }
  if (t.dataset.clip) {
    try { await api('/v1/history/clip', { method: 'POST', body: JSON.stringify({ text: $('#clip').value, from: $('#clipfrom').value }) }); $('#status').textContent = 'Saved to your AI history.'; } catch (err) { $('#status').textContent = 'History: ' + err.message; }
    return show('memory');
  }
  if (t.dataset.suggest) {
    t.disabled = true;
    try { const r = await api('/v1/history/conversations/' + encodeURIComponent(t.dataset.suggest) + '/suggest-memories', { method: 'POST', body: '{}' }); $('#status').textContent = r.proposed + ' suggestion(s) waiting for your OK.'; } catch (err) { $('#status').textContent = 'History: ' + err.message; }
    return show('memory');
  }
  if (t.dataset.ctl) { await api('/v1/controls/' + t.dataset.ctl, { method: 'POST', body: '{}' }); return show('settings'); }
});
document.addEventListener('change', async (e) => {
  if (e.target.dataset && e.target.dataset.pref) {
    const k = e.target.dataset.pref; const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    await api('/v1/notifications/prefs', { method: 'PUT', body: JSON.stringify({ [k]: v }) }); return;
  }
  if (e.target.dataset && e.target.dataset.voiceset) {
    const k = e.target.dataset.voiceset; const v = k === 'mode' ? e.target.value : Number(e.target.value);
    await api('/v1/voice/settings', { method: 'PUT', body: JSON.stringify({ [k]: v }) }); return;
  }
  if (e.target.id === 'histfile' && e.target.files && e.target.files[0]) {
    const f = e.target.files[0];
    $('#status').textContent = 'Importing ' + f.name + '…';
    try {
      const isZip = /\\.zip$/i.test(f.name) || f.type === 'application/zip';
      const r = isZip
        ? await api('/v1/history/import-zip', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: f })
        : await api('/v1/history/import', { method: 'POST', body: JSON.stringify({ json: await f.text() }) });
      $('#status').textContent = 'Imported ' + r.conversations + ' conversations (' + r.messages + ' messages) from ' + r.source + '.';
    } catch (err) { $('#status').textContent = 'Import: ' + err.message; }
    return show('memory');
  }
  if (e.target.id === 'hq') {
    const hits = await api('/v1/history/search?q=' + encodeURIComponent(e.target.value));
    $('#hres').innerHTML = hits.map((h) => \`<div class="card"><b>\${esc(h.title)}</b> <span class="muted">\${esc(h.source)}\${h.project ? ' · ' + esc(h.project) : ''} · \${esc(h.role)}</span><div>\${esc(h.excerpt)}</div><button data-suggest="\${esc(h.conversationId)}">Suggest memories</button></div>\`).join('') || '<p class="muted">Nothing in your imported chats matches.</p>';
    return;
  }
  if (e.target.id !== 'mq') return;
  const res = await api('/v1/memory?q=' + encodeURIComponent(e.target.value));
  const list = Array.isArray(res) ? res.map((r) => r.entry ? r : { entry: r, freshness: r.status, sourceRef: r.source && r.source.ref }) : [];
  $('#mres').innerHTML = list.map(r => \`<div class="card">\${esc(r.entry.value)}<div class="muted">\${esc(r.freshness)} · source \${esc(r.sourceRef)}</div><div class="row"><button class="btn" data-memfix="\${r.entry.id}">Correct</button><button class="btn" data-memact="\${r.entry.id}|delete">Forget</button></div></div>\`).join('') || '<p class="muted">No matching memory.</p>';
});
// ---- Live voice: WebRTC straight to the realtime model with an ephemeral key; tools run on our server.
let rtc = null;
let chatSession = null;
let chatLog = [];
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'chatin') { e.preventDefault(); document.querySelector('[data-chat=send]').click(); } });
const voiceLang = () => { const l = (navigator.language || 'en').toLowerCase(); return l.startsWith('pt') ? 'pt-BR' : l.startsWith('es') ? 'es' : l.startsWith('it') ? 'it' : 'en'; };
const setVoice = (state) => { const b = $('#voice'); b.dataset.state = state; b.textContent = { offline: 'Talk', connecting: '…', listening: 'Listening', thinking: 'Thinking', acting: 'Working', speaking: 'Speaking', muted: 'Muted' }[state] || state; b.setAttribute('aria-label', 'Jennifer: ' + state + '. Tap to ' + (state === 'offline' ? 'talk' : 'hang up')); };
async function startVoice() {
  setVoice('connecting');
  const s = await api('/v1/voice/session', { method: 'POST', body: JSON.stringify({ language: voiceLang() }) });
  const pc = new RTCPeerConnection();
  const audio = document.createElement('audio'); audio.autoplay = true; audio.setAttribute('playsinline', '');
  pc.ontrack = (e) => { audio.srcObject = e.streams[0]; };
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  pc.addTrack(mic.getTracks()[0], mic);
  const dc = pc.createDataChannel('oai-events');
  dc.onopen = () => dc.send(JSON.stringify({ type: 'response.create' }));
  dc.onmessage = async (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'input_audio_buffer.speech_started') setVoice('listening');
    else if (ev.type === 'response.created') setVoice('thinking');
    else if (ev.type === 'output_audio_buffer.started') setVoice('speaking');
    else if (ev.type === 'output_audio_buffer.stopped' || ev.type === 'output_audio_buffer.cleared') setVoice('listening');
    else if (ev.type === 'error') $('#status').textContent = 'Voice: ' + (ev.error && ev.error.message);
    else if (ev.type === 'response.output_item.done' && ev.item && ev.item.type === 'function_call') {
      setVoice('acting');
      const r = await api('/v1/voice/tools/' + encodeURIComponent(ev.item.name), { method: 'POST', body: JSON.stringify({ arguments: ev.item.arguments }) }).catch((err) => ({ ok: false, error: err.message }));
      dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.item.call_id, output: JSON.stringify(r) } }));
      dc.send(JSON.stringify({ type: 'response.create' }));
    }
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const ans = await fetch(s.callsUrl, { method: 'POST', body: offer.sdp, headers: { authorization: 'Bearer ' + s.clientSecret, 'content-type': 'application/sdp' } });
  if (!ans.ok) throw new Error('voice connection refused (' + ans.status + ')');
  await pc.setRemoteDescription({ type: 'answer', sdp: await ans.text() });
  rtc = { pc, mic, dc, audio };
  setVoice('listening');
}
function stopVoice() {
  if (rtc) { try { rtc.dc.close(); } catch {} rtc.mic.getTracks().forEach((t) => t.stop()); rtc.pc.close(); rtc = null; }
  setVoice('offline');
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

const startTab = new URLSearchParams(location.search).get('tab');
if (token) show(startTab && views[startTab] ? startTab : 'today'); else $('#view').innerHTML = '<p class="muted">Sign in with your passkey to continue.</p>';
</script>
</body>
</html>`;
