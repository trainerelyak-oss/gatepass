import { esc, icon, describeRecord, recordDetails, formatTime, formatDateTime, formatDuration, timeAgo } from './ui.js';
import { qrSvg } from './qr.js';
import { zonePicker, zoneList } from './config.js';

const POLL_MS = 3000;
const DEVICE_STALE_MS = 2 * 60 * 1000;

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'checkin', label: 'Sign-ins' },
  { id: 'checkout', label: 'Sign-outs' },
  { id: 'denied', label: 'Refused' },
  { id: 'muster', label: 'Roll calls' }
];

const ALERT_ICONS = {
  pass_reused: 'qr',
  watchlist: 'ban',
  denied: 'ban',
  id_mismatch: 'alert',
  overstay: 'clock',
  items_missing: 'logOut',
  temp_review: 'clock',
  spotcheck: 'scan',
  check: 'clipboard',
  incident: 'alert',
  revoked: 'ban'
};

let view = 'overview';
let selectedIncident = null;
let lastIncidentRender = null;

let config = { site: { name: '' }, gates: [], visitorTypes: [] };
let state = null;
let filter = 'all';
let connected = false;
let lastFetch = null;
let firstLoad = true;
const seen = new Set();
const fresh = new Set();
const expanded = new Set();

const typeLabel = id => config.visitorTypes.find(t => t.id === id)?.label || id;

function delay(record) {
  return record.receivedAt ? new Date(record.receivedAt) - new Date(record.createdAt) : 0;
}

function offlineBadge(offline, ms) {
  return offline
    ? `<span class="badge badge-offline">${icon('cloudOff')} Offline · synced +${formatDuration(ms)}</span>`
    : `<span class="badge badge-synced">${icon('check')} Live</span>`;
}

function renderKpis() {
  const s = state.stats;
  const tiles = [
    { label: 'On site now', value: s.onSite, note: `${s.today} signed in today` },
    { label: 'Alerts', value: s.alerts, note: s.highAlerts ? `${s.highAlerts} high priority` : 'nothing urgent', tone: s.highAlerts ? 'danger' : s.alerts ? 'warn' : 'ok' },
    { label: 'Captured offline', value: s.offlineEvents, note: s.longestOfflineMs ? `longest gap ${formatDuration(s.longestOfflineMs)}` : 'no outages yet', tone: s.offlineEvents ? 'info' : '' },
    { label: 'Open incidents', value: s.openIncidents, note: s.pendingReviews ? `${s.pendingReviews} temp pass${s.pendingReviews > 1 ? 'es' : ''} to review` : 'no reviews pending', tone: s.openIncidents ? 'warn' : '' }
  ];
  document.getElementById('kpis').innerHTML = tiles.map(t => `
    <div class="kpi ${t.tone ? `kpi-${t.tone}` : ''}">
      <span class="kpi-label">${esc(t.label)}</span>
      <strong class="kpi-value">${esc(t.value)}</strong>
      <span class="kpi-note">${esc(t.note)}</span>
    </div>`).join('');
}

function renderAlerts() {
  const panel = document.getElementById('alerts-panel');
  panel.hidden = !state.alerts.length;
  document.getElementById('alerts').innerHTML = state.alerts.map(a => `
    <li class="alert alert-${a.severity} ${fresh.has(a.id) ? 'is-fresh' : ''}">
      <span class="alert-icon">${icon(ALERT_ICONS[a.kind] || 'alert')}</span>
      <span class="alert-body">
        <strong>${esc(a.title)}</strong>
        <small>${esc(a.detail)}</small>
      </span>
      <span class="alert-meta">
        ${formatTime(a.at)}
        ${a.offline ? `<span class="badge badge-offline">${icon('cloudOff')} found on sync</span>` : ''}
      </span>
    </li>`).join('');
}

function renderOnSite() {
  const onSite = state.visits.filter(v => v.status === 'on_site');
  document.getElementById('onsite-note').textContent = `${onSite.length} people`;
  document.getElementById('onsite').innerHTML = onSite.length
    ? `
      <thead><tr><th>Badge</th><th>Name</th><th>Type</th><th>Visiting</th><th>In</th><th></th></tr></thead>
      <tbody>
        ${onSite.map(v => `
          <tr class="${(v.flags || []).length ? 'is-flagged' : ''} ${fresh.has(v.visitId) ? 'is-fresh' : ''}">
            <td class="mono">${esc(v.badge || '')}</td>
            <td><strong>${esc(v.name)}</strong>${v.company ? `<small>${esc(v.company)}</small>` : ''}</td>
            <td>${esc(typeLabel(v.visitorType))}${v.inducted ? ' <span class="tag">inducted</span>' : ''}${v.tempPass ? ' <span class="tag tag-temp">temp</span>' : ''}<small>${esc(zoneList(config, v.zones))}${v.escort ? ' · escort' : ''}</small>${v.items?.filter(i => i.kind === 'issued').length ? `<small>Holding: ${esc(v.items.filter(i => i.kind === 'issued').map(i => i.ref ? `${i.name} ${i.ref}` : i.name).join(', '))}</small>` : ''}</td>
            <td>${esc(v.host || '')}</td>
            <td>${formatTime(v.checkinAt)}<small>Gate ${esc(v.checkinGate)}</small></td>
            <td>${(v.flags || []).map(f => `<span class="tag tag-${f}">${esc(f.replace('_', ' '))}</span>`).join(' ')}${v.checkinOffline ? `<span class="tag tag-offline">offline +${formatDuration(v.checkinDelayMs)}</span>` : ''}</td>
          </tr>`).join('')}
      </tbody>`
    : '<tbody><tr><td class="empty">No visitors on site.</td></tr></tbody>';
}

function renderFeed() {
  document.getElementById('feed-filters').innerHTML = FILTERS.map(f => {
    const count = f.id === 'all' ? state.feed.length : state.feed.filter(r => r.type === f.id).length;
    return `<button class="chip ${f.id === filter ? 'active' : ''}" data-filter="${f.id}">${f.label} <span class="chip-count">${count}</span></button>`;
  }).join('');

  const visible = state.feed.filter(r => filter === 'all' || r.type === filter);
  document.getElementById('feed').innerHTML = visible.length
    ? visible.map(record => {
        const d = describeRecord(record);
        return `
          <li class="record tone-${d.tone} ${fresh.has(record.id) ? 'is-fresh' : ''} ${expanded.has(record.id) ? 'open' : ''}" data-id="${esc(record.id)}">
            <button class="record-row">
              <span class="record-icon">${icon(d.icon)}</span>
              <span class="record-body">
                <strong>${esc(d.title)}</strong>
                <small>${esc(d.subtitle)}</small>
                <span class="record-meta">Gate ${esc(record.gate || '?')} · ${esc(record.guardName || '')} · ${formatDateTime(record.createdAt)}</span>
              </span>
              ${offlineBadge(record.recordedOffline, delay(record))}
            </button>
            ${expanded.has(record.id) ? `<div class="record-details">${recordDetails(record)}<p class="detail-meta">Received by server ${formatDateTime(record.receivedAt)}</p></div>` : ''}
          </li>`;
      }).join('')
    : '<li class="empty">Nothing yet. Activity appears here as gate devices sync.</li>';
}

function renderDevices() {
  const el = document.getElementById('devices');
  el.innerHTML = state.devices.length
    ? state.devices.map(d => {
        const silent = Date.now() - new Date(d.lastSeenAt) > DEVICE_STALE_MS;
        return `
          <li class="device ${silent ? 'is-dark' : ''}">
            <span class="device-dot"></span>
            <span class="device-body">
              <strong>${esc(d.postName || config.gates.find(g => g.id === d.gate)?.name || `Gate ${d.gate || '?'}`)}${d.temporaryUntil ? ` <span class="tag tag-temp">temporary until ${formatTime(d.temporaryUntil)}</span>` : ''}</strong>
              <small>${esc(d.guardName || 'Unknown officer')}</small>
            </span>
            <span class="device-state">${silent ? `Offline · last seen ${timeAgo(d.lastSeenAt)}` : 'Connected'}</span>
          </li>`;
      }).join('')
    : '<li class="empty">No gate devices have connected yet.</li>';
}

function renderMuster() {
  const latest = state.musters[0];
  const el = document.getElementById('muster');
  if (!latest) {
    el.innerHTML = '<p class="muted small">No evacuations recorded.</p>';
    return;
  }
  el.innerHTML = `
    <div class="muster-summary ${latest.missing.length ? 'has-missing' : ''}">
      <strong>${latest.accounted.length}/${latest.total} accounted</strong>
      <small>${formatDateTime(latest.startedAt)} · Gate ${esc(latest.gate)} · ${esc(latest.guardName || '')}${latest.recordedOffline ? ' · run offline' : ''}</small>
    </div>
    ${latest.missing.length ? `<ul class="missing-mini">${latest.missing.map(m => `<li>${esc(m.name)} <small>${esc(m.host || '')}</small></li>`).join('')}</ul>` : ''}
  `;
}

function renderInvites() {
  document.getElementById('invites').innerHTML = state.invites.length
    ? state.invites.slice(0, 12).map(i => {
        const used = state.visits.filter(v => v.passId === i.id).length;
        const expired = new Date(i.validTo) < Date.now();
        return `
          <li>
            <button class="invite-row" data-pass="${esc(i.id)}">
              <span class="mono invite-code">${esc(i.id)}</span>
              <span class="invite-body">
                <strong>${esc(i.name)}</strong>
                <small>${esc(typeLabel(i.type))} · ${esc(i.host)}</small>
              </span>
              <span class="invite-state">${expired ? 'Expired' : used ? `Used ${used}×` : 'Not used'}</span>
            </button>
          </li>`;
      }).join('')
    : '<li class="empty">No passes yet.</li>';
}

function renderLive() {
  const el = document.querySelector('.live');
  el.dataset.tone = connected ? 'online' : 'offline';
  el.querySelector('.live-label').textContent = connected
    ? `Live · ${lastFetch ? timeAgo(lastFetch.toISOString()) : ''}`
    : 'Server unreachable';
}

const statusLabel = s => ({ open: 'Open', investigating: 'Investigating', escalated: 'Escalated', closed: 'Closed' })[s] || s;

function renderCounts() {
  const open = state.stats.openIncidents;
  const reviews = state.stats.pendingReviews;
  document.querySelector('[data-count="incidents"]').textContent = open ? open : '';
  document.querySelector('[data-count="reviews"]').textContent = reviews ? reviews : '';
}

function renderIncidents() {
  document.getElementById('incident-list').innerHTML = state.incidents.length
    ? state.incidents.map(i => `
        <li class="record tone-${i.severity === 'critical' || i.severity === 'high' ? 'danger' : i.currentStatus === 'closed' ? 'neutral' : 'warn'} ${selectedIncident === i.incidentId ? 'selected' : ''} ${fresh.has(i.id) ? 'is-fresh' : ''}">
          <button class="record-row" data-incident="${esc(i.incidentId)}">
            <span class="record-icon">${icon('alert')}</span>
            <span class="record-body">
              <strong>${esc(i.title)}</strong>
              <small>${esc(i.categoryLabel || i.category)} · ${esc(i.severity)} · ${esc(i.location || '')}</small>
              <span class="record-meta">${esc(i.guardName || '')} · ${formatDateTime(i.createdAt)} · ${i.witnesses.length} witness · ${i.evidence.length} evidence</span>
            </span>
            <span class="badge status-${esc(i.currentStatus)}">${esc(statusLabel(i.currentStatus))}</span>
          </button>
        </li>`).join('')
    : '<li class="empty">No incidents reported.</li>';

  const incident = state.incidents.find(i => i.incidentId === selectedIncident);
  const form = document.getElementById('followup-form');
  form.hidden = !incident;
  if (!incident) return;
  const signature = JSON.stringify([incident.updatedAt, incident.currentStatus, incident.witnesses.length, incident.evidence.length, incident.notes.length]);
  if (signature === lastIncidentRender) return;
  lastIncidentRender = signature;

  document.getElementById('incident-detail').innerHTML = `
    <span class="eyebrow">${esc(incident.categoryLabel || incident.category)} · ${esc(incident.severity)}</span>
    <h2 class="incident-title">${esc(incident.title)}</h2>
    <p class="muted small">${esc(incident.location || '')} · Gate ${esc(incident.gate || '?')} · ${esc(incident.guardName || '')} · ${formatDateTime(incident.createdAt)}${incident.recordedOffline ? ` · recorded offline, synced +${formatDuration(delay(incident))}` : ''}</p>
    <span class="badge status-${esc(incident.currentStatus)}">${esc(statusLabel(incident.currentStatus))}</span>
    ${incident.description ? `<p class="detail-text">${esc(incident.description)}</p>` : ''}
    ${incident.people?.length || incident.otherPeople ? `<p class="small"><strong>Involved:</strong> ${esc([...(incident.people || []).map(p => `${p.name} (${p.badge})`), incident.otherPeople].filter(Boolean).join(', '))}</p>` : ''}
    ${incident.photos?.length ? `<div class="detail-photos">${incident.photos.map(src => `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt=""></a>`).join('')}</div>` : ''}

    <h3>Witness statements (${incident.witnesses.length})</h3>
    ${incident.witnesses.map(w => `
      <article class="doc-card">
        <strong>${esc(w.name)}</strong><small class="muted">${esc(w.role)}${w.contact ? ` · ${esc(w.contact)}` : ''}${w.partialId ? ` · ID •••${esc(w.partialId)}` : ''}</small>
        <p class="detail-text">“${esc(w.statement)}”</p>
        ${w.signature ? `<img class="detail-signature" src="${esc(w.signature)}" alt="Signature">` : ''}
        <small class="muted">Taken by ${esc(w.guardName || '')} · ${formatDateTime(w.createdAt)}</small>
      </article>`).join('') || '<p class="muted small">None.</p>'}

    <h3>Evidence register (${incident.evidence.length})</h3>
    ${incident.evidence.length ? `<table class="evidence-table"><thead><tr><th>Ref</th><th>Item</th><th>Custody</th><th>Photo integrity</th></tr></thead><tbody>
      ${incident.evidence.map(e => `
        <tr>
          <td class="mono">${esc(e.ref)}</td>
          <td><strong>${esc(e.description)}</strong><small>Found: ${esc(e.foundAt || '—')} · ${esc(e.guardName || '')} · ${formatDateTime(e.createdAt)}</small>
            ${e.photos?.length ? `<div class="detail-photos">${e.photos.map(src => `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt=""></a>`).join('')}</div>` : ''}</td>
          <td>${esc(e.custody)}</td>
          <td>${(e.photoIntegrity || []).map((r, i) => `<span class="tag ${r === 'verified' ? '' : 'tag-pass_reused'}" title="${esc(e.photoHashes?.[i] || '')}">${r === 'verified' ? 'verified' : 'MODIFIED'}</span>`).join(' ') || '<span class="muted small">no photo</span>'}</td>
        </tr>`).join('')}
    </tbody></table>` : '<p class="muted small">None.</p>'}

    <h3>Follow-up</h3>
    <ul class="timeline">
      ${incident.notes.map(n => `
        <li class="${n.source === 'control' ? 'from-control' : ''}">
          <span class="timeline-meta">${n.source === 'control' ? 'Control room' : `${esc(n.guardName || '')} · Gate ${esc(n.gate || '?')}`} · ${formatDateTime(n.createdAt)}</span>
          ${n.status ? `<span class="badge status-${esc(n.status)}">${esc(statusLabel(n.status))}</span>` : ''}
          ${n.text ? `<p>${esc(n.text)}</p>` : ''}
        </li>`).join('') || '<li class="muted small">No updates yet.</li>'}
    </ul>
  `;
}

function renderReviews() {
  const rows = state.tempPasses;
  document.getElementById('review-table').innerHTML = rows.length ? `
    <thead><tr><th>Pass</th><th>Person</th><th>Reason</th><th>Issued</th><th>Valid until</th><th>Review</th></tr></thead>
    <tbody>
      ${rows.map(t => `
        <tr class="${t.review?.decision === 'revoked' ? 'is-flagged' : ''}">
          <td class="mono">${esc(t.id)}</td>
          <td><strong>${esc(t.name)}</strong><small>${esc(t.badge || '')} · ${t.status === 'on_site' ? 'on site' : 'left'}</small></td>
          <td>${esc(t.reason)}</td>
          <td>${formatTime(t.issuedAt)}<small>Gate ${esc(t.gate)} · ${esc(t.guardName || '')}${t.offline ? ' · offline' : ''}</small></td>
          <td>${formatTime(t.validTo)}</td>
          <td>${t.review
            ? `<span class="tag ${t.review.decision === 'revoked' ? 'tag-pass_reused' : ''}">${esc(t.review.decision)}</span><small>${esc(t.review.by)} · ${formatTime(t.review.at)}</small>`
            : `<div class="review-actions"><button class="btn btn-secondary" data-review="approved" data-pass="${esc(t.id)}">Approve</button><button class="btn btn-danger" data-review="revoked" data-pass="${esc(t.id)}">Revoke</button></div>`}</td>
        </tr>`).join('')}
    </tbody>` : '<tbody><tr><td class="empty">No temporary passes issued.</td></tr></tbody>';
}

function renderChecksAndShifts() {
  document.getElementById('check-list').innerHTML = state.checks.length
    ? state.checks.slice(0, 30).map(c => {
        const issues = c.faults.length + c.shortages.length;
        return `
          <li class="record tone-${issues ? 'warn' : 'ok'} open">
            <div class="record-row">
              <span class="record-icon">${icon('clipboard')}</span>
              <span class="record-body">
                <strong>${esc(c.checkName)}</strong>
                <small>${issues ? `${issues} issue${issues > 1 ? 's' : ''}` : 'All clear'} · Gate ${esc(c.gate)} · ${esc(c.guardName || '')}</small>
                <span class="record-meta">${formatDateTime(c.createdAt)}${c.recordedOffline ? ` · offline, synced +${formatDuration(delay(c))}` : ''}</span>
              </span>
            </div>
            ${issues ? `<div class="record-details">${c.faults.map(f => `<p class="detail-line detail-warn">Fault: ${esc(f.label)}${f.note ? ` (${esc(f.note)})` : ''}</p>`).join('')}${c.shortages.map(s => `<p class="detail-line detail-warn">Short: ${esc(s.label)} · ${s.count}/${s.expected}${s.note ? ` (${esc(s.note)})` : ''}</p>`).join('')}</div>` : ''}
          </li>`;
      }).join('')
    : '<li class="empty">No checks yet.</li>';

  document.getElementById('shift-list').innerHTML = state.shiftReports.length
    ? state.shiftReports.slice(0, 20).map(r => {
        const s = r.summary || {};
        return `
          <li class="record tone-neutral open">
            <div class="record-row">
              <span class="record-icon">${icon('user')}</span>
              <span class="record-body">
                <strong>${esc(r.guardName || '')} · ${esc(r.postName || `Gate ${r.gate}`)}</strong>
                <small>${formatTime(s.shiftStart)}–${formatTime(s.shiftEnd)} · ${s.signIns ?? 0} in · ${s.signOuts ?? 0} out · ${s.refusals?.length ?? 0} refused · ${s.incidents?.length ?? 0} incidents</small>
                <span class="record-meta">Handed over to ${esc(r.incomingOfficer || '—')}${r.recordedOffline ? ' · submitted offline' : ''}</span>
              </span>
            </div>
            <div class="record-details">
              ${r.notes ? `<p class="detail-text">${esc(r.notes)}</p>` : ''}
              ${s.itemsOut?.length ? `<p class="detail-line detail-warn">Items still out: ${esc(s.itemsOut.map(i => `${i.item} (${i.who})`).join(', '))}</p>` : ''}
              ${s.onSite?.length ? `<p class="detail-line">On site at handover: ${esc(s.onSite.map(v => v.name).join(', '))}</p>` : ''}
              ${r.signature ? `<img class="detail-signature" src="${esc(r.signature)}" alt="Signature">` : ''}
            </div>
          </li>`;
      }).join('')
    : '<li class="empty">No shift reports yet.</li>';
}

function renderAll() {
  if (state) {
    renderCounts();
    if (view === 'incidents') renderIncidents();
    if (view === 'reviews') renderReviews();
    if (view === 'checks') renderChecksAndShifts();
    renderKpis();
    if (view === 'overview') {
      renderAlerts();
      renderOnSite();
      renderFeed();
      renderDevices();
      renderMuster();
      renderInvites();
    }
  }
  renderLive();
}

async function poll() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    state = await res.json();
    fresh.clear();
    const ids = [...state.feed.map(r => r.id), ...state.alerts.map(a => a.id), ...state.visits.map(v => v.visitId), ...state.incidents.map(i => i.id)];
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        if (!firstLoad) fresh.add(id);
      }
    }
    firstLoad = false;
    connected = true;
    lastFetch = new Date();
  } catch {
    connected = false;
  }
  renderAll();
}

function passLink(token) {
  return `${location.origin}/pass#${token}`;
}

function showPass(invite) {
  const dialog = document.getElementById('pass-dialog');
  document.getElementById('pass-dialog-title').textContent = invite.name;
  document.getElementById('pass-dialog-qr').innerHTML = qrSvg(invite.token);
  document.getElementById('pass-dialog-code').textContent = invite.id;
  document.getElementById('pass-dialog-open').href = passLink(invite.token);
  document.getElementById('pass-dialog-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(passLink(invite.token));
      document.getElementById('pass-dialog-copy').textContent = 'Copied';
    } catch {
      prompt('Copy this link', passLink(invite.token));
    }
  };
  document.getElementById('pass-dialog-copy').textContent = 'Copy link';
  dialog.showModal();
}

function toLocalInput(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date - offset).toISOString().slice(0, 16);
}

function setupInviteForm() {
  const form = document.getElementById('invite-form');
  document.getElementById('invite-type').innerHTML = config.visitorTypes.map(t => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
  const zoneBox = document.getElementById('invite-zones');
  const resetZones = () => { zoneBox.innerHTML = zonePicker(config, config.defaultZones?.[form.type.value] || [], 'invite-zone'); };
  resetZones();
  form.type.addEventListener('change', resetZones);
  const now = new Date();
  now.setMinutes(Math.floor(now.getMinutes() / 15) * 15, 0, 0);
  form.from.value = toLocalInput(now);
  form.to.value = toLocalInput(new Date(now.getTime() + 4 * 60 * 60 * 1000));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      const res = await fetch('/api/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.visitor.value,
          type: form.type.value,
          partialId: form.pid.value,
          company: form.company.value,
          host: form.host.value,
          validFrom: new Date(form.from.value).toISOString(),
          validTo: new Date(form.to.value).toISOString(),
          multiEntry: form.multi.checked,
          escort: form.escort.checked,
          zones: [...form.querySelectorAll('[name=invite-zone]:checked')].map(i => i.value)
        })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not create pass');
      form.visitor.value = '';
      form.pid.value = '';
      form.company.value = '';
      await poll();
      showPass(body);
    } catch (err) {
      alert(err.message);
    } finally {
      button.disabled = false;
    }
  });
}

async function boot() {
  document.querySelectorAll('[data-icon]').forEach(el => {
    el.innerHTML = icon(el.dataset.icon);
  });
  try {
    config = await (await fetch('/data/site.json', { cache: 'no-store' })).json();
  } catch {}

  setupInviteForm();

  document.getElementById('dash-tabs').addEventListener('click', event => {
    const tab = event.target.closest('[data-view]');
    if (!tab) return;
    view = tab.dataset.view;
    document.querySelectorAll('#dash-tabs [data-view]').forEach(b => b.classList.toggle('active', b === tab));
    document.querySelectorAll('.dash-view').forEach(el => { el.hidden = el.dataset.view !== view; });
    lastIncidentRender = null;
    renderAll();
  });

  document.getElementById('incident-list').addEventListener('click', event => {
    const row = event.target.closest('[data-incident]');
    if (!row) return;
    selectedIncident = row.dataset.incident;
    lastIncidentRender = null;
    renderIncidents();
  });

  document.getElementById('followup-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    if (!selectedIncident) return;
    const res = await fetch(`/api/incidents/${encodeURIComponent(selectedIncident)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: form.text.value, status: form.status.value || null, by: 'Control room' })
    });
    if (!res.ok) return alert((await res.json()).error || 'Could not save');
    form.reset();
    lastIncidentRender = null;
    await poll();
  });

  document.getElementById('review-table').addEventListener('click', async event => {
    const button = event.target.closest('[data-review]');
    if (!button) return;
    if (button.dataset.review === 'revoked' && !confirm('Revoke this temporary pass? Gates will refuse it after their next sync.')) return;
    button.disabled = true;
    await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passId: button.dataset.pass, decision: button.dataset.review, by: 'Control room' })
    });
    await poll();
  });

  document.getElementById('feed-filters').addEventListener('click', event => {
    const chip = event.target.closest('[data-filter]');
    if (!chip) return;
    filter = chip.dataset.filter;
    renderFeed();
  });

  document.getElementById('feed').addEventListener('click', event => {
    const row = event.target.closest('.record-row');
    if (!row) return;
    const id = row.closest('.record').dataset.id;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    renderFeed();
  });

  document.getElementById('invites').addEventListener('click', event => {
    const row = event.target.closest('[data-pass]');
    const invite = row && state?.invites.find(i => i.id === row.dataset.pass);
    if (invite) showPass(invite);
  });

  const dialog = document.getElementById('pass-dialog');
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());

  await poll();
  setInterval(poll, POLL_MS);
}

if (document.readyState === 'complete') boot();
else window.addEventListener('load', boot);
