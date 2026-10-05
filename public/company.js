// Jennifer Company OS command center (blueprint §6). Loaded after the main
// dashboard script and uses its globals: api, esc, $, show, views.
/* global api, esc, $, show, views */
(() => {
  const DEPT = {
    sales: { label: 'Sales', color: '#3b82c4' },
    deals: { label: 'Deals', color: '#8a5cc2' },
    marketing: { label: 'Marketing', color: '#c2577a' },
    operations: { label: 'Operations', color: '#c48a2c' },
    intelligence: { label: 'Intelligence', color: '#2f9a8a' },
    customer: { label: 'Customer', color: '#4f9a3f' },
    back_office: { label: 'Back office', color: '#7a7f8a' },
  };
  const READY = { ready: 'Ready', needs_setup: 'Needs setup', paused: 'Paused', design_only: 'Design only' };
  const RUN = { queued: 'Queued', running: 'Running', waiting_approval: 'Waiting for your approval', blocked: 'Blocked', reconciling: 'Checking an outcome', succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
  const st = { cid: null, sub: 'map', dept: '', q: '', role: null, run: null, poll: null };
  try { st.cid = localStorage.getItem('jennifer_company'); } catch {}
  const setCid = (c) => { st.cid = c; try { localStorage.setItem('jennifer_company', c); } catch {} };
  const badge = (text, kind) => `<span class="cbadge ${kind || ''}">${esc(text)}</span>`;
  const readyBadge = (r) => badge(READY[r] || r, r === 'ready' ? 'ok' : r === 'needs_setup' ? 'warn' : r === 'paused' ? 'warn' : '');
  const base = () => '/v1/companies/' + encodeURIComponent(st.cid);
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

  // ---- styles (navy operating-diagram look, scoped to the company view) ----
  const css = document.createElement('style');
  css.textContent = `
    .cos { --navy:#0f1b2d; --navy2:#16263d; --edge:#2a3c57; --ink:#e8eef7; --teal:#2bb3a6; }
    .cos .shell { background:var(--navy); color:var(--ink); border-radius:14px; padding:12px; }
    .cos .shell .muted { color:#9fb0c7; }
    .cos .shell .card { background:var(--navy2); border-color:var(--edge); color:var(--ink); }
    .cos .shell .btn { background:var(--navy2); color:var(--ink); border-color:var(--edge); }
    .cos .shell .btn.primary { background:var(--teal); border-color:var(--teal); color:#04201d; }
    .cos .shell input, .cos .shell select, .cos .shell textarea { background:#0b1524; color:var(--ink); border-color:var(--edge); }
    .cos .tabs { display:flex; gap:6px; overflow-x:auto; margin:8px 0 12px; }
    .cos .tabs button { background:none; border:1px solid var(--edge); color:#c9d6e8; border-radius:999px; padding:6px 12px; font:inherit; white-space:nowrap; min-height:36px; }
    .cos .tabs button[aria-current="true"] { background:var(--teal); color:#04201d; border-color:var(--teal); }
    .cos .map { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; }
    .cos .hub { grid-column:1/-1; text-align:center; border:2px solid var(--teal); border-radius:14px; padding:12px; }
    .cos .dept { text-align:left; border-radius:12px; padding:10px; border:1px solid var(--edge); background:var(--navy2); color:var(--ink); border-left:6px solid var(--c); min-height:44px; font:inherit; cursor:pointer; }
    .cos .cbadge { display:inline-block; font-size:12px; padding:1px 8px; border-radius:999px; border:1px solid var(--edge); margin-left:4px; }
    .cos .cbadge.ok { border-color:#2bb36b; color:#7fe0a8; } .cos .cbadge.warn { border-color:#d29a3a; color:#f2c27a; }
    .cos .steps li { margin:4px 0; }
    .cos label { display:block; margin:6px 0; }
    .cos a, .cos .linklike { color:#8fd9cf; cursor:pointer; background:none; border:0; font:inherit; padding:0; text-decoration:underline; }
  `;
  document.head.appendChild(css);

  // ---- navigation button ----
  const nav = document.querySelector('nav');
  if (nav && !nav.querySelector('[data-tab="company"]')) {
    const b = document.createElement('button');
    b.dataset.tab = 'company';
    b.textContent = 'Company';
    nav.insertBefore(b, nav.children[1] || null);
  }

  const SUBS = [['map', 'Map'], ['roles', 'Roles'], ['run', 'Start work'], ['history', 'Runs'], ['approvals', 'Approvals'], ['brain', 'Brain'], ['crm', 'CRM'], ['settings', 'Settings']];

  views.company = async () => {
    if (st.poll) { clearTimeout(st.poll); st.poll = null; }
    const companies = await api('/v1/companies');
    if (!st.cid || !companies.some((c) => c.id === st.cid)) setCid(companies[0] && companies[0].id);
    const company = companies.find((c) => c.id === st.cid);
    const switcher = `<label>Company <select data-cos-company>${companies.map((c) => `<option value="${c.id}" ${c.id === st.cid ? 'selected' : ''}>${esc(c.name)}${c.status === 'paused' ? ' (paused)' : ''}${c.pending.approvals + c.pending.crmChanges + c.pending.drafts ? ' · ' + (c.pending.approvals + c.pending.crmChanges + c.pending.drafts) + ' to review' : ''}</option>`).join('')}</select></label>`;
    const tabs = `<div class="tabs" role="tablist">${SUBS.map(([k, l]) => `<button role="tab" data-cos-sub="${k}" aria-current="${st.sub === k}">${l}</button>`).join('')}</div>`;
    let body = '';
    try { body = await SUB[st.sub](company); } catch (e) { body = `<div class="card bad">${esc(e.message)}</div>`; }
    return `<div class="cos"><div class="shell">${switcher}${company && company.status === 'paused' ? '<div class="card bad">This company is paused: no new work or external actions.</div>' : ''}${tabs}${body}</div></div>`;
  };

  const SUB = {
    async map() {
      const m = await api(base() + '/map');
      const depts = m.departments.map((d) => `<button class="dept" style="--c:${DEPT[d.id].color}" data-cos-dept="${d.id}"><strong>${DEPT[d.id].label}</strong><div class="muted">${d.total} roles · ${d.ready} ready · ${d.needsSetup} need setup</div></button>`).join('');
      return `<div class="map"><div class="hub"><strong>Jennifer</strong> <span class="muted">coordinator</span><div class="muted">${m.coordinator.activeRuns ? m.coordinator.activeRuns + ' runs in progress' : 'No work running right now'}</div></div>${depts}</div>
        <p class="muted">${m.totals.roles} role definitions: ${m.totals.ready} ready, ${m.totals.needsSetup} need setup, ${m.totals.designOnly} are design records not yet built. A role counts as ready only when its executor, tools, sources and tests exist.</p>`;
    },
    async roles() {
      if (st.role) return roleDetail(st.role);
      const list = await api(base() + '/roles' + (st.dept ? '?department=' + st.dept : ''));
      const q = st.q.toLowerCase();
      const rows = list.filter((r) => !q || (r.id + ' ' + r.name + ' ' + r.responsibility + ' ' + r.deliverable).toLowerCase().includes(q));
      return `<label>Search roles <input data-cos-q value="${esc(st.q)}" placeholder="e.g. reply, invoice, grant"></label>
        <label>Department <select data-cos-deptsel><option value="">All</option>${Object.entries(DEPT).map(([k, v]) => `<option value="${k}" ${st.dept === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
        <p class="muted">${rows.length} roles</p>` +
        (rows.map((r) => `<div class="card"><button class="linklike" data-cos-role="${r.id}">${esc(r.id)} · ${esc(r.name)}</button>${readyBadge(r.readiness)}${r.pilot ? badge('pilot') : ''}<div class="muted">${esc(r.deliverable)} · phase ${r.phase}</div></div>`).join('') || '<p class="muted">No roles match. Clear the search or filter.</p>');
    },
    async run(company) {
      const wfs = await api('/v1/workflows');
      const convs = (await api('/v1/conversations?space=' + st.cid).catch(() => [])).slice(0, 30);
      const form = (w) => {
        if (w.id === 'WF-01') return `<label>Segment <input data-in="segment" placeholder="e.g. independent insurance brokers"></label><label>Geography <input data-in="geography" placeholder="e.g. Milan"></label><label>Batch size (max 10) <input data-in="batchLimit" type="number" min="1" max="10" value="5"></label><label>Language <select data-in="language"><option>en</option><option>pt</option><option>es</option><option>fr</option><option>it</option></select></label>`;
        if (w.id === 'WF-02') return convs.length ? `<label>Conversation <select data-in="conversationId">${convs.map((c) => `<option value="${c.id}">${esc(c.subject || '(no subject)')} — ${esc((c.lastFrom && c.lastFrom.address) || '')}</option>`).join('')}</select></label>` : '<p class="muted">No conversations in this company yet.</p>';
        return '';
      };
      return wfs.map((w) => `<div class="card" data-wf="${w.id}"><strong>${esc(w.id)} · ${esc(w.name)}</strong><div class="muted">${esc(w.description)}</div>
        <ol class="steps muted">${w.steps.map((s) => `<li>${esc(s.label)}${s.roleId ? ' (' + s.roleId + ')' : ''}</li>`).join('')}</ol>${form(w)}
        <label>Budget € <input data-in="budget" type="number" step="0.1" min="0.1" max="25" value="${w.defaultBudgetEur}"></label>
        <div class="row"><button class="btn primary" data-cos-start="${w.id}" ${company && company.status === 'paused' ? 'disabled' : ''}>Start</button></div></div>`).join('');
    },
    async history() {
      if (st.run) return runDetail(st.run);
      const runs = await api(base() + '/runs');
      return runs.map((r) => `<div class="card"><button class="linklike" data-cos-run="${r.id}">${esc(r.workflowId)} · ${esc(new Date(r.createdAt).toLocaleString())}</button>${badge(RUN[r.status] || r.status, r.status === 'succeeded' ? 'ok' : ['blocked', 'failed'].includes(r.status) ? 'warn' : '')}<div class="muted">${esc(r.summary || '')} · €${r.spentEur.toFixed(3)}</div></div>`).join('') || '<p class="muted">No runs yet. Start one under “Start work”.</p>';
    },
    async approvals() {
      const a = await api(base() + '/approvals');
      const drafts = a.drafts.map((d) => artifactCard(d, true)).join('');
      const crm = a.crmChanges.map((p) => `<div class="card"><strong>CRM ${esc(p.kind)}${p.recordId ? ' update' : ' (new)'}</strong> <span class="muted">${esc(p.reason)}</span>
        <ul>${Object.entries(p.changes).map(([k, c]) => `<li>${esc(k)}: ${c.from !== undefined ? '<s>' + esc(String(c.from)) + '</s> → ' : ''}${esc(String(c.to))} <span class="muted">${esc(c.source || '')}</span></li>`).join('')}</ul>
        <div class="row"><button class="btn primary" data-cos-patch="${p.id}|apply">Apply</button><button class="btn" data-cos-patch="${p.id}|reject">Reject</button></div></div>`).join('');
      const kn = a.knowledge.map((s) => `<div class="card"><strong>Knowledge: ${esc(s.title)}</strong> <span class="muted">${esc(s.category)} · ${esc(s.classification)}</span><div class="row"><button class="btn primary" data-cos-src="${s.id}|approved">Approve</button><button class="btn" data-cos-src="${s.id}|revoked">Reject</button></div></div>`).join('');
      const acts = a.actions.length ? `<div class="card">${a.actions.length} message(s) waiting for your approval — see <button class="linklike" data-tab="today">Today</button>.</div>` : '';
      return (acts + drafts + crm + kn) || '<p class="muted">Nothing waiting for review in this company.</p>';
    },
    async brain() {
      const sources = await api(base() + '/knowledge/sources');
      return `<div class="card"><strong>Add approved company knowledge</strong><p class="muted">Offer, ideal customer profile, brand voice, allowed claims, procedures. Nothing is used until you approve it.</p>
        <label>Title <input data-kb="title"></label>
        <label>Category <select data-kb="category">${['offer', 'icp', 'brand', 'claims', 'procedures', 'pricing', 'other'].map((c) => `<option>${c}</option>`).join('')}</select></label>
        <label>Classification <select data-kb="classification"><option>internal</option><option>public</option><option>confidential</option><option>restricted</option></select></label>
        <label>Text <textarea data-kb="text" rows="5"></textarea></label><label>or URL <input data-kb="url" type="url"></label>
        <div class="row"><button class="btn primary" data-cos-addsrc="1">Add</button></div></div>
        <label>Search the brain <input data-cos-kbq placeholder="search approved knowledge"></label><div id="kbres"></div>` +
        sources.map((s) => `<div class="card"><strong>${esc(s.title)}</strong> ${badge(s.status, s.status === 'approved' ? 'ok' : s.status === 'pending_review' ? 'warn' : '')}<div class="muted">${esc(s.category)} · ${esc(s.classification)} · ${esc(s.origin.ref || 'text')}${s.error ? ' · ' + esc(s.error) : ''}</div>
          <div class="row">${s.status === 'pending_review' ? `<button class="btn primary" data-cos-src="${s.id}|approved">Approve</button>` : ''}${s.status !== 'revoked' ? `<button class="btn" data-cos-src="${s.id}|revoked">Revoke</button>` : ''}</div></div>`).join('');
    },
    async crm() {
      const recs = await api(base() + '/crm');
      const group = (k) => recs.filter((r) => r.kind === k);
      const show = (r) => `<div class="card"><strong>${esc(r.fields.name || r.fields.title || r.fields.email || r.id)}</strong> <span class="muted">v${r.version}</span><div class="muted">${Object.entries(r.fields).filter(([k]) => !['name', 'title'].includes(k)).map(([k, v]) => esc(k) + ': ' + esc(String(v))).join(' · ')}</div></div>`;
      return `<div class="card"><strong>Add a task</strong><label>Title <input data-task="title"></label><label>Due <input data-task="due" type="date"></label><div class="row"><button class="btn" data-cos-addtask="1">Add task</button></div></div>` +
        ['account', 'contact', 'opportunity', 'task'].map((k) => `<h3>${k[0].toUpperCase() + k.slice(1)}s</h3>` + (group(k).map(show).join('') || '<p class="muted">None yet.</p>')).join('');
    },
    async settings(company) {
      return `<div class="card"><strong>Automation for ${esc(company.name)}</strong>
        <label>Daily brief at (local time, ${esc(company.timezone)}) <input data-cos-brief type="time" value="${esc(company.profile.briefTime || '')}"></label>
        <p class="muted">Leave empty to run the brief only when you ask.</p>
        <label><input type="checkbox" data-cos-triage ${company.profile.autoTriage ? 'checked' : ''}> Triage new replies in this company automatically (classify, honor opt-outs, propose CRM updates; nothing is sent)</label>
        <div class="row"><button class="btn primary" data-cos-saveset="1">Save</button></div></div>
        <div class="card"><strong>Emergency stop for this company</strong><p class="muted">Pausing cancels running work and blocks new runs. Messages already sent cannot be unsent.</p>
        <div class="row">${company.status === 'paused' ? '<button class="btn primary" data-cos-status="active">Resume company</button>' : '<button class="btn danger" data-cos-status="paused">Pause company</button>'}</div></div>`;
    },
  };

  async function roleDetail(id) {
    const r = await api(base() + '/roles/' + id);
    const c = r.configuration;
    return `<button class="linklike" data-cos-role="">← All roles</button><div class="card" style="border-left:6px solid ${DEPT[r.department].color}"><strong>${esc(r.id)} · ${esc(r.name)}</strong>${readyBadge(r.readiness)}
      <p>${esc(r.responsibility)}</p><div class="muted">Deliverable: ${esc(r.deliverable)} · Mode: ${esc(r.mode.replace('_', ' '))} · Phase ${r.phase}</div>
      ${r.blockers.length ? '<div class="bad">' + r.blockers.map(esc).join('<br>') + '</div>' : ''}
      ${c ? `<h4>Configuration v${c.version}</h4><div class="muted">Owner: ${esc(c.ownerRole)} · Tools: ${esc(c.allowedTools.join(', ') || 'none')} · Knowledge: ${esc(c.retrievalScopes.join(', ') || 'none')} · Actions: ${esc(c.actionPolicy)} · Limits: ${c.limits.maxModelTurns} turns, ${c.limits.maxToolCalls} tool calls, ${c.limits.timeoutMs / 1000}s · Budget €${c.budgetEur}</div><pre>${esc(c.promptTemplate)}</pre>` : '<p class="muted">Design record: no executable configuration yet.</p>'}
      <h4>Recent runs</h4>${r.history.map((h) => `<div class="muted">${esc(h.workflowId)} · ${esc(RUN[h.status] || h.status)} · ${esc(new Date(h.at).toLocaleString())}</div>`).join('') || '<p class="muted">None.</p>'}</div>`;
  }

  function artifactCard(a, review) {
    const c = a.content || {};
    let body = '';
    if (a.kind === 'email_draft') body = `<div class="muted">To ${esc(c.to)} · ${esc(c.account)}</div><label>Subject <input data-ed="subject-${a.id}" value="${esc(c.subject)}"></label><label>Message <textarea data-ed="body-${a.id}" rows="7">${esc(c.body)}</textarea></label>${(c.flags || []).map((f) => '<div class="bad">' + esc(f) + '</div>').join('')}`;
    else if (a.kind === 'executive_brief') body = ['priorities', 'overdue', 'blockers', 'decisions'].map((k) => (c[k] && c[k].length ? `<h4>${k[0].toUpperCase() + k.slice(1)}</h4><ul>${c[k].map((i) => `<li>${esc(i.title)}${i.why ? ' — ' + esc(i.why) : ''}${i.due ? ' (due ' + esc(i.due) + ')' : ''} <span class="muted">${esc(i.ref)}</span></li>`).join('')}</ul>` : '')).join('') + (c.gaps && c.gaps.length ? '<h4>Gaps</h4><ul>' + c.gaps.map((g) => '<li class="bad">' + esc(g) + '</li>').join('') + '</ul>' : '') + (c.measured ? `<div class="muted">Yesterday: ${c.measured.completedRuns} runs done, ${c.measured.failedRuns} failed/blocked, €${c.measured.spentEur}</div>` : '');
    else body = `<pre>${esc(JSON.stringify(c, null, 2))}</pre>`;
    const src = (a.sources || []).map((s) => esc(s.sourceId)).join(', ');
    const actions = review && a.review === 'pending' ? `<div class="row"><button class="btn primary" data-cos-art="${a.id}|approved">Approve</button><button class="btn" data-cos-art="${a.id}|rejected">Reject</button></div>` : a.kind === 'email_draft' && a.review === 'approved' ? `<div class="row"><button class="btn" data-cos-prep="${a.id}">Prepare to send (you approve the exact email)</button></div>` : '';
    return `<div class="card"><strong>${esc(a.title)}</strong>${badge(a.review, a.review === 'approved' ? 'ok' : a.review === 'pending' ? 'warn' : '')}${body}${src ? '<div class="muted">Sources: ' + src + '</div>' : ''}${actions}</div>`;
  }

  async function runDetail(id) {
    const r = await api(base() + '/runs/' + id);
    const events = await api(base() + '/runs/' + id + '/events');
    const live = ['queued', 'running'].includes(r.status);
    if (live) st.poll = setTimeout(() => { if (st.sub === 'history' && st.run === id) show('company'); }, 1500);
    return `<button class="linklike" data-cos-run="">← All runs</button><div class="card"><strong>${esc(r.workflowId)} v${r.workflowVersion}</strong>${badge(RUN[r.status] || r.status, r.status === 'succeeded' ? 'ok' : ['blocked', 'failed'].includes(r.status) ? 'warn' : '')}
      <div class="muted">Started ${esc(new Date(r.createdAt).toLocaleString())} by ${esc(r.initiatedBy)} · €${r.spentEur.toFixed(3)} of €${r.budgetEur}</div>
      ${r.summary ? '<p>' + esc(r.summary) + '</p>' : ''}${r.blockers.length ? '<div class="bad">' + r.blockers.map(esc).join('<br>') + '</div>' : ''}
      <ol class="steps">${r.steps.map((s) => `<li>${esc(s.key)}${s.roleId ? ' (' + s.roleId + ')' : ''} — ${esc(s.status)}</li>`).join('')}</ol>
      ${live ? `<div class="row"><button class="btn danger" data-cos-cancel="${r.id}">Cancel</button></div><p class="muted">Cancelling stops future steps; it cannot undo anything already sent.</p>` : ''}</div>
      ${r.artifacts.map((a) => artifactCard(a, true)).join('')}
      <details><summary>Event log (${events.length})</summary>${events.map((e) => `<div class="muted">#${e.seq} ${esc(e.type)} ${esc(JSON.stringify(e.data)).slice(0, 200)}</div>`).join('')}</details>`;
  }

  const val = (sel) => { const el = document.querySelector(sel); return el ? el.value : ''; };
  const say = (t) => { $('#status').textContent = t; };

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button, [data-cos-role], [data-cos-run]') || e.target;
    const d = t.dataset || {};
    try {
      if (d.cosSub) { st.sub = d.cosSub; st.role = null; st.run = null; return show('company'); }
      if (d.cosDept !== undefined) { st.dept = d.cosDept; st.sub = 'roles'; st.role = null; return show('company'); }
      if (d.cosRole !== undefined) { st.role = d.cosRole || null; return show('company'); }
      if (d.cosRun !== undefined) { st.run = d.cosRun || null; st.sub = 'history'; return show('company'); }
      if (d.cosStart) {
        const card = t.closest('[data-wf]');
        const input = {};
        card.querySelectorAll('[data-in]').forEach((el) => { if (el.dataset.in !== 'budget' && el.value) input[el.dataset.in] = el.type === 'number' ? Number(el.value) : el.value; });
        const budget = Number(card.querySelector('[data-in="budget"]').value) || undefined;
        const r = await api(base() + '/runs', { method: 'POST', headers: { 'idempotency-key': uuid() }, body: JSON.stringify({ workflowId: d.cosStart, input, budgetEur: budget }) });
        st.run = r.id; st.sub = 'history'; return show('company');
      }
      if (d.cosCancel) { await api(base() + '/runs/' + d.cosCancel + '/cancel', { method: 'POST', body: '{}' }); return show('company'); }
      if (d.cosArt) {
        const [id, decision] = d.cosArt.split('|');
        const subj = document.querySelector(`[data-ed="subject-${id}"]`);
        const bod = document.querySelector(`[data-ed="body-${id}"]`);
        await api(base() + '/artifacts/' + id + '/review', { method: 'POST', body: JSON.stringify({ decision, edits: subj ? { subject: subj.value, body: bod.value } : undefined }) });
        return show('company');
      }
      if (d.cosPrep) { const r = await api(base() + '/artifacts/' + d.cosPrep + '/prepare-send', { method: 'POST', body: '{}' }); say('Ready for your approval in Today.'); return r; }
      if (d.cosPatch) { const [id, decision] = d.cosPatch.split('|'); await api(base() + '/crm/patches/' + id, { method: 'POST', body: JSON.stringify({ decision }) }); return show('company'); }
      if (d.cosSrc) { const [id, decision] = d.cosSrc.split('|'); await api(base() + '/knowledge/sources/' + id + '/review', { method: 'POST', body: JSON.stringify({ decision }) }); return show('company'); }
      if (d.cosAddsrc) {
        const body = { title: val('[data-kb="title"]'), category: val('[data-kb="category"]'), classification: val('[data-kb="classification"]') };
        if (val('[data-kb="text"]')) body.text = val('[data-kb="text"]'); else body.url = val('[data-kb="url"]');
        const s = await api(base() + '/knowledge/sources', { method: 'POST', body: JSON.stringify(body) });
        say(s.status === 'failed' ? 'Could not read that source: ' + s.error : 'Added. Approve it to make it company knowledge.');
        return show('company');
      }
      if (d.cosAddtask) { await api(base() + '/crm/records', { method: 'POST', body: JSON.stringify({ kind: 'task', fields: { title: val('[data-task="title"]'), due: val('[data-task="due"]') || undefined, status: 'open', owner: 'Bruno' } }) }); return show('company'); }
      if (d.cosSaveset) { await api(base() + '/profile', { method: 'PUT', body: JSON.stringify({ briefTime: val('[data-cos-brief]') || null, autoTriage: document.querySelector('[data-cos-triage]').checked }) }); say('Saved.'); return show('company'); }
      if (d.cosStatus) { if (d.cosStatus === 'paused' && !confirm('Pause all work for this company?')) return; await api(base() + '/status', { method: 'POST', body: JSON.stringify({ status: d.cosStatus }) }); return show('company'); }
    } catch (err) { say('Company: ' + err.message); }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.cosCompany !== undefined) { setCid(t.value); st.role = null; st.run = null; return show('company'); }
    if (t.dataset.cosDeptsel !== undefined) { st.dept = t.value; return show('company'); }
    if (t.dataset.cosQ !== undefined) { st.q = t.value; return show('company'); }
    if (t.dataset.cosKbq !== undefined) {
      const hits = await api(base() + '/knowledge/search', { method: 'POST', body: JSON.stringify({ query: t.value }) }).catch(() => []);
      $('#kbres').innerHTML = hits.map((h) => `<div class="card"><strong>${esc(h.title)}</strong> <span class="muted">${esc(h.locator)}</span><div>${esc(h.text.slice(0, 400))}</div></div>`).join('') || '<p class="muted">No approved knowledge matches.</p>';
    }
  });
})();
