import { esc, icon, describeRecord, recordDetails, formatTime, formatDateTime, formatDuration, timeAgo } from './ui.js';
import { qrSvg } from './qr.js';
import { zonePicker, zoneList } from './config.js';
import { feedback, soundEnabled, setSound } from './feedback.js';
import { currentTheme, setTheme } from './theme.js';

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
let handledOpen = false;
let invitesExpanded = false;
const openRecords = new Set();
let token = null;
let me = null;
let pollTimer = null;

try {
  token = localStorage.getItem('gp-dash-token');
} catch {}

function storeToken(value) {
  token = value;
  try {
    value ? localStorage.setItem('gp-dash-token', value) : localStorage.removeItem('gp-dash-token');
  } catch {}
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    cache: 'no-store',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showAuth('login', 'Your session ended. Sign in again.');
    throw Object.assign(new Error(body.error || 'Please sign in'), { auth: true });
  }
  if (res.status === 403 && path === '/api/state') {
    storeToken(null);
    showAuth('login', 'That account is a security officer account. The control room needs a supervisor or admin.');
    throw Object.assign(new Error(body.error), { auth: true });
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function showAuth(mode, message) {
  clearInterval(pollTimer);
  pollTimer = null;
  const screen = document.getElementById('auth-screen');
  screen.hidden = false;
  screen.dataset.mode = mode;
  document.getElementById('auth-title').textContent = mode === 'setup' ? 'Set up GatePass' : 'Control room sign in';
  document.getElementById('auth-sub').textContent = mode === 'setup'
    ? 'Create the first admin account. You can add officers and supervisors after this.'
    : 'Supervisors and admins only.';
  document.querySelector('#auth-form [data-setup]').hidden = mode !== 'setup';
  document.getElementById('auth-submit').textContent = mode === 'setup' ? 'Create admin account' : 'Sign in';
  const error = document.getElementById('auth-error');
  error.hidden = !message;
  error.textContent = message || '';
  document.querySelector('#auth-form [name=username]').focus();
}

function hideAuth() {
  document.getElementById('auth-screen').hidden = true;
}

function startPolling() {
  hideAuth();
  poll();
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);
}

function applyRole() {
  const admin = me?.role === 'admin';
  document.body.classList.toggle('is-admin', admin);
  const chip = document.getElementById('user-chip');
  chip.textContent = me ? `${me.name} · ${me.roleLabel}` : '';
  if (!admin && view === 'admin') document.querySelector('#dash-tabs [data-view="overview"]').click();
}
let feedExpanded = false;
let onsiteQuery = '';
let knownHigh = null;
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

const ACK_LABEL = { false_alarm: 'False alarm', resolved: 'Resolved' };

function alertItem(a) {
  return `
    <li class="alert alert-${a.severity} ${a.ack ? 'is-handled' : ''} ${fresh.has(a.id) ? 'is-fresh' : ''}">
      <span class="alert-icon">${icon(ALERT_ICONS[a.kind] || 'alert')}</span>
      <span class="alert-body">
        <strong>${esc(a.title)}</strong>
        <small>${esc(a.detail)}</small>
        ${a.ack ? `<small class="ack-line">${esc(ACK_LABEL[a.ack.status] || a.ack.status)} · ${esc(a.ack.by)} · ${formatTime(a.ack.at)}${a.ack.note ? ` · "${esc(a.ack.note)}"` : ''}</small>` : ''}
      </span>
      <span class="alert-meta">
        ${formatTime(a.at)}
        ${a.offline ? `<span class="badge badge-offline">${icon('cloudOff')} found on sync</span>` : ''}
        <span class="ack-actions">
          ${a.ack
            ? `<button class="link-button" data-ack="open" data-alert="${esc(a.id)}">Reopen</button>`
            : `<button class="btn btn-ghost btn-sm" data-ack="false_alarm" data-alert="${esc(a.id)}">False alarm</button><button class="btn btn-secondary btn-sm" data-ack="resolved" data-alert="${esc(a.id)}">Resolved</button>`}
        </span>
      </span>
    </li>`;
}

function renderAlerts() {
  const panel = document.getElementById('alerts-panel');
  const open = state.alerts.filter(a => !a.ack);
  const handled = state.alerts.filter(a => a.ack);
  panel.hidden = !state.alerts.length;
  panel.classList.toggle('all-handled', !open.length);
  document.getElementById('alerts').innerHTML = `
    ${open.map(alertItem).join('') || '<li class="empty small">No open alerts.</li>'}
    ${handled.length ? `
      <li class="handled-group">
        <details ${handledOpen ? 'open' : ''}>
          <summary>Handled (${handled.length})</summary>
          <ul class="alerts">${handled.map(alertItem).join('')}</ul>
        </details>
      </li>` : ''}`;
}

function renderOnSite() {
  const q = onsiteQuery.toLowerCase();
  const onSite = state.visits.filter(v => v.status === 'on_site' && (!q || [v.name, v.badge, v.host, v.company].some(f => String(f || '').toLowerCase().includes(q))));
  document.getElementById('onsite-note').textContent = `${state.stats.onSite}`;
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
            <td>${formatTime(v.checkinAt)}<small>Gate ${esc(v.checkinGate)}</small>${passFor(v) ? `<button class="link-button qr-link" data-visit-qr="${esc(v.visitId)}">${icon('qr')} Pass</button>` : ''}</td>
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

  const all = state.feed.filter(r => filter === 'all' || r.type === filter);
  const visible = feedExpanded ? all : all.slice(0, 8);
  document.getElementById('feed').innerHTML = visible.length
    ? visible.map(record => {
        const d = describeRecord(record);
        return `
          <li class="record tone-${d.tone} ${fresh.has(record.id) ? 'is-fresh' : ''} ${expanded.has(record.id) ? 'open' : ''}" data-id="${esc(record.id)}">
            <button class="record-row">
              <span class="record-icon">${icon(d.icon)}</span>
              <span class="record-body">
                <strong>${esc(d.title)}${record.test ? ' <span class="tag tag-test">TEST</span>' : ''}</strong>
                <small>${esc(d.subtitle)}</small>
                <span class="record-meta">Gate ${esc(record.gate || '?')} · ${esc(record.guardName || '')} · ${formatDateTime(record.createdAt)}</span>
              </span>
              ${offlineBadge(record.recordedOffline, delay(record))}
            </button>
            ${expanded.has(record.id) ? `<div class="record-details">${recordDetails(record)}<p class="detail-meta">Received by server ${formatDateTime(record.receivedAt)}</p></div>` : ''}
          </li>`;
      }).join('') + (all.length > visible.length ? `<li><button class="link-button" id="feed-more" type="button">Show all ${all.length}</button></li>` : '')
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
            <span class="device-state">${silent ? `Offline · last seen ${timeAgo(d.lastSeenAt)}` : 'Connected'}${d.pending ? `<small>${d.pending} waiting to upload</small>` : ''}</span>
          </li>`;
      }).join('')
    : '<li class="empty">No gate devices have connected yet.</li>';
}

function renderMuster() {
  const latest = state.musters[0];
  const el = document.getElementById('muster');
  el.closest('.dash-panel').hidden = !latest;
  if (!latest) return;
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
    ? state.invites.slice(0, invitesExpanded ? 500 : 8).map(i => {
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
      }).join('') + (state.invites.length > 8 && !invitesExpanded ? `<li><button class="link-button" id="invites-more" type="button">Show all ${state.invites.length}</button></li>` : '')
    : '<li class="empty">No passes yet.</li>';
}

function renderLive() {
  const el = document.querySelector('.live');
  el.dataset.tone = connected ? 'online' : 'offline';
  el.querySelector('.live-label').textContent = connected
    ? `Live · ${lastFetch ? timeAgo(lastFetch.toISOString()) : ''}`
    : 'Server unreachable';
}

const statusLabel = s => ({ open: 'Open', investigating: 'Investigating', escalated: 'Escalated', closed: 'Closed', false_alarm: 'False alarm' })[s] || s;

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
          <td>${formatTime(t.validTo)}${t.token ? `<button class="link-button qr-link" data-temp-qr="${esc(t.id)}">${icon('qr')} QR</button>` : ''}</td>
          <td>${t.review
            ? `<span class="tag ${t.review.decision === 'revoked' ? 'tag-pass_reused' : ''}">${esc(t.review.decision)}</span><small>${esc(t.review.by)} · ${formatTime(t.review.at)}</small>`
            : `<div class="review-actions"><button class="btn btn-secondary" data-review="approved" data-pass="${esc(t.id)}">Approve</button><button class="btn btn-danger" data-review="revoked" data-pass="${esc(t.id)}">Revoke</button></div>`}</td>
        </tr>`).join('')}
    </tbody>` : '<tbody><tr><td class="empty">No temporary passes issued.</td></tr></tbody>';
}

function checkDetails(c) {
  const results = (c.results || []).map(r => {
    const bad = r.result === 'fault' || r.result === 'short';
    const value = r.type === 'count' ? `${r.count}/${r.expected}` : ({ ok: 'OK', fault: 'Fault', na: 'N/A' })[r.result] || r.result;
    return `<li class="${bad ? 'is-bad' : ''}"><span class="check-result">${esc(value)}</span><span>${esc(r.label)}${r.note ? `<em>${esc(r.note)}</em>` : ''}</span></li>`;
  }).join('');
  return `
    <div class="record-details">
      ${results ? `<ul class="check-results">${results}</ul>` : ''}
      ${c.notes ? `<p class="detail-text"><strong>Notes:</strong> ${esc(c.notes)}</p>` : '<p class="muted small">No notes added.</p>'}
      ${c.photos?.length ? `<div class="detail-photos">${c.photos.map(src => `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt=""></a>`).join('')}</div>` : ''}
    </div>`;
}

function shiftDetails(r) {
  const s = r.summary || {};
  const list = (title, items) => items?.length ? `<p class="detail-line"><strong>${title}:</strong> ${esc(items.join(', '))}</p>` : '';
  return `
    <div class="record-details">
      ${r.notes ? `<p class="detail-text"><strong>Handover notes:</strong> ${esc(r.notes)}</p>` : '<p class="muted small">No handover notes.</p>'}
      ${list('On site at handover', (s.onSite || []).map(v => `${v.name} (${v.badge || '—'})`))}
      ${s.itemsOut?.length ? `<p class="detail-line detail-warn"><strong>Items still out:</strong> ${esc(s.itemsOut.map(i => `${i.item} with ${i.who}`).join(', '))}</p>` : ''}
      ${s.itemsMissing?.length ? `<p class="detail-line detail-warn"><strong>Not returned this shift:</strong> ${esc(s.itemsMissing.map(i => `${i.item} (${i.who})`).join(', '))}</p>` : ''}
      ${list('Refusals', (s.refusals || []).map(x => `${x.name || 'Unknown'}: ${x.reason}`))}
      ${list('Temporary passes', (s.tempPasses || []).map(t => `${t.name} until ${formatTime(t.until)}`))}
      ${list('Spot check failures', (s.spotFailures || []).map(f => `${f.name || 'Unknown'} in ${f.zone}`))}
      ${list('Incidents', (s.incidents || []).map(i => `${i.title} (${i.severity})`))}
      ${list('Site checks', (s.checks || []).map(c => `${c.name}: ${c.issues ? `${c.issues} issue(s)` : 'all clear'}`))}
      ${list('Roll calls', (s.rollCalls || []).map(m => `${formatTime(m.at)} ${m.total - m.missing}/${m.total}`))}
      ${s.pendingUpload ? `<p class="detail-line detail-warn">${s.pendingUpload} record(s) were still waiting to upload when this was written.</p>` : ''}
      ${r.signature ? `<img class="detail-signature" src="${esc(r.signature)}" alt="Signature">` : ''}
    </div>`;
}

function renderChecksAndShifts() {
  document.getElementById('check-list').innerHTML = state.checks.length
    ? state.checks.slice(0, 40).map(c => {
        const issues = c.faults.length + c.shortages.length;
        return `
          <li class="record tone-${issues ? 'warn' : 'ok'} ${openRecords.has(c.id) ? 'open' : ''}">
            <button class="record-row" data-open-record="${esc(c.id)}">
              <span class="record-icon">${icon('clipboard')}</span>
              <span class="record-body">
                <strong>${esc(c.checkName)}${c.test ? ' <span class="tag tag-test">TEST</span>' : ''}</strong>
                <small>${issues ? `${issues} issue${issues > 1 ? 's' : ''}` : 'All clear'} · Gate ${esc(c.gate)} · ${esc(c.guardName || '')}${c.notes ? ' · has notes' : ''}</small>
                <span class="record-meta">${formatDateTime(c.createdAt)}${c.recordedOffline ? ` · offline, synced +${formatDuration(delay(c))}` : ''}</span>
              </span>
              ${icon('chevron')}
            </button>
            ${openRecords.has(c.id) ? checkDetails(c) : ''}
          </li>`;
      }).join('')
    : '<li class="empty">No checks yet.</li>';

  document.getElementById('shift-list').innerHTML = state.shiftReports.length
    ? state.shiftReports.slice(0, 30).map(r => {
        const s = r.summary || {};
        return `
          <li class="record tone-neutral ${openRecords.has(r.id) ? 'open' : ''}">
            <button class="record-row" data-open-record="${esc(r.id)}">
              <span class="record-icon">${icon('user')}</span>
              <span class="record-body">
                <strong>${esc(r.guardName || '')} · ${esc(r.postName || `Gate ${r.gate}`)}</strong>
                <small>${formatTime(s.shiftStart)}–${formatTime(s.shiftEnd)} · ${s.signIns ?? 0} in · ${s.signOuts ?? 0} out · ${s.refusals?.length ?? 0} refused · ${s.incidents?.length ?? 0} incidents</small>
                <span class="record-meta">Handed over to ${esc(r.incomingOfficer || '—')}${r.notes ? ' · has notes' : ''}${r.recordedOffline ? ' · submitted offline' : ''}</span>
              </span>
              ${icon('chevron')}
            </button>
            ${openRecords.has(r.id) ? shiftDetails(r) : ''}
          </li>`;
      }).join('')
    : '<li class="empty">No shift reports yet.</li>';
}

function notifyAlerts() {
  const high = state.alerts.filter(a => a.severity === 'high' && !a.ack);
  document.title = high.length ? `(${high.length}) GatePass · Control room` : 'GatePass · Control room';
  const ids = new Set(high.map(a => a.id));
  if (knownHigh && [...ids].some(id => !knownHigh.has(id))) feedback('warn');
  knownHigh = ids;
}

function renderAll() {
  if (state) {
    notifyAlerts();
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
  if (!token) return;
  try {
    state = await api('/api/state');
    me = state.me;
    applyRole();
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
  } catch (err) {
    if (err.auth) return;
    connected = false;
  }
  renderAll();
}

let adminData = null;

async function loadAdmin() {
  const [users, watch] = await Promise.all([api('/api/users'), api('/api/watchlist')]);
  adminData = { users: users.users, watch: watch.entries };
  renderAdmin();
}

function renderAdmin() {
  if (!adminData) return;
  document.getElementById('users-table').innerHTML = `
    <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
    <tbody>
      ${adminData.users.map(u => `
        <tr class="${u.active ? '' : 'is-muted'}">
          <td><strong>${esc(u.name)}</strong>${u.lastLoginAt ? `<small>Last sign-in ${formatDateTime(u.lastLoginAt)}</small>` : '<small>Never signed in</small>'}</td>
          <td class="mono">${esc(u.username)}</td>
          <td>
            <select data-role="${esc(u.id)}" ${u.id === me?.id ? 'disabled' : ''}>
              ${['officer', 'supervisor', 'admin'].map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${{ officer: 'Security officer', supervisor: 'Supervisor', admin: 'Admin' }[r]}</option>`).join('')}
            </select>
          </td>
          <td>${u.active ? '<span class="tag">Active</span>' : '<span class="tag tag-id_mismatch">Disabled</span>'}</td>
          <td class="row-actions">
            <button class="btn btn-secondary btn-sm" data-reset-pw="${esc(u.id)}">Reset password</button>
            ${u.id === me?.id ? '' : `<button class="btn btn-ghost btn-sm" data-toggle-user="${esc(u.id)}" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>`}
          </td>
        </tr>`).join('')}
    </tbody>`;
  document.getElementById('watch-list').innerHTML = adminData.watch.length
    ? adminData.watch.map(w => `
        <li>
          <span class="watch-main"><strong>${esc(w.name)}</strong><small>ID •••${esc(w.partialId)} · ${w.level === 'deny' ? 'Do not admit' : 'Escort + alert'}${w.reason ? ` · ${esc(w.reason)}` : ''}</small></span>
          <button class="btn btn-ghost btn-sm" data-unwatch="${esc(w.id)}">Remove</button>
        </li>`).join('')
    : '<li class="empty">Nobody on the watchlist.</li>';
}

function tamper(token) {
  const [head, body, signature] = token.split('.');
  const padded = body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (body.length % 4)) % 4);
  const payload = JSON.parse(atob(padded));
  payload.e += 7 * 24 * 60 * 60;
  const forged = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${head}.${forged}.${signature}`;
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const rows = [['Badge', 'Name', 'Type', 'Company', 'Host', 'Zones', 'Signed in', 'Gate in', 'Signed out', 'Gate out', 'Flags', 'Recorded offline']];
  for (const v of state.visits) {
    rows.push([v.badge, v.name, typeLabel(v.visitorType), v.company, v.host, zoneList(config, v.zones), v.checkinAt, v.checkinGate, v.checkoutAt, v.checkoutGate, (v.flags || []).join(' '), v.checkinOffline ? 'yes' : 'no']);
  }
  const blob = new Blob([rows.map(r => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `gatepass-visits-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function renderToggles() {
  document.getElementById('sound-toggle').innerHTML = icon(soundEnabled() ? 'bell' : 'bellOff');
  document.getElementById('theme-toggle').innerHTML = icon(currentTheme() === 'dark' ? 'sun' : 'moon');
}

function passLink(token) {
  return `${location.origin}/pass#${token}`;
}

function passFor(visit) {
  if (visit.tempPass?.token) return { id: visit.tempPass.id, name: `${visit.name} (temporary)`, token: visit.tempPass.token, temporary: true };
  return state.invites.find(i => i.id === visit.passId) || null;
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
  document.getElementById('pass-dialog-kind').textContent = invite.temporary
    ? 'Temporary pass signed by the officer\'s phone. Scan it at any gate or in a spot check.'
    : 'Visitor pass signed by this server. Scan it with a gate phone to test.';
  const tamperButton = document.getElementById('pass-dialog-tamper');
  const qrBox = document.getElementById('pass-dialog-qr');
  const kind = document.getElementById('pass-dialog-kind');
  const realKind = kind.textContent;
  let forgedShown = false;
  qrBox.classList.remove('is-forged');
  tamperButton.textContent = 'Show forged QR (end date pushed back 7 days, original signature kept)';
  tamperButton.onclick = () => {
    forgedShown = !forgedShown;
    qrBox.innerHTML = qrSvg(forgedShown ? tamper(invite.token) : invite.token);
    qrBox.classList.toggle('is-forged', forgedShown);
    kind.textContent = forgedShown ? 'FORGED copy for the demo. Scan it with a gate phone: it should be refused.' : realKind;
    tamperButton.textContent = forgedShown ? 'Show the real QR again' : 'Show forged QR (end date pushed back 7 days, original signature kept)';
  };
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
      const body = await api('/api/invites', {
        method: 'POST',
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
      form.visitor.value = '';
      form.pid.value = '';
      form.company.value = '';
      await poll();
      document.getElementById('invite-dialog').close();
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

  renderToggles();
  document.getElementById('sound-toggle').addEventListener('click', () => {
    setSound(!soundEnabled());
    renderToggles();
    if (soundEnabled()) feedback('warn');
  });
  document.getElementById('theme-toggle').addEventListener('click', () => {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    renderToggles();
  });

  document.getElementById('onsite-search').addEventListener('input', event => {
    onsiteQuery = event.target.value.trim();
    renderOnSite();
  });
  document.getElementById('export-csv').addEventListener('click', () => state && exportCsv());

  const inviteDialog = document.getElementById('invite-dialog');
  document.getElementById('new-pass').addEventListener('click', () => inviteDialog.showModal());
  inviteDialog.querySelector('[data-close]').addEventListener('click', () => inviteDialog.close());

  const connect = document.getElementById('connect-dialog');
  const openConnect = () => {
    const url = `${location.origin}/`;
    document.getElementById('connect-qr').innerHTML = qrSvg(url);
    document.getElementById('connect-url').textContent = url;
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    const secure = location.protocol === 'https:';
    const warning = document.getElementById('connect-warning');
    warning.hidden = secure;
    warning.textContent = local
      ? 'This address only works on this computer. Start a tunnel (npx localtunnel --port 3000) or deploy, then open the dashboard through that https address and connect devices from there.'
      : 'Phones need https for the camera and offline pass checks. Use a tunnel or a deployed https address.';
    connect.showModal();
  };
  document.getElementById('connect-open').addEventListener('click', openConnect);
  document.getElementById('connect-top').addEventListener('click', openConnect);
  connect.querySelector('[data-close]').addEventListener('click', () => connect.close());

  const demo = document.getElementById('demo-dialog');
  document.getElementById('demo-open').addEventListener('click', () => demo.showModal());
  demo.querySelector('[data-close]').addEventListener('click', () => demo.close());
  document.getElementById('demo-reset').addEventListener('click', async () => {
    if (!confirm('Reset all demo data on the server?')) return;
    await api('/api/demo/reset', { method: 'POST', body: '{}' });
    knownHigh = null;
    seen.clear();
    selectedIncident = null;
    await poll();
    demo.close();
  });
  document.getElementById('demo-seed').addEventListener('click', async () => {
    try {
      const result = await api('/api/demo/seed', { method: 'POST', body: '{}' });
      if (result.accounts?.length) alert(`Demo accounts created:\n${result.accounts.map(a => `${a.username} / ${a.password} (${a.role})`).join('\n')}`);
    } catch (err) {
      alert(err.message);
    }
    await poll();
    demo.close();
  });
  document.getElementById('demo-fake').addEventListener('click', async () => {
    await api('/api/demo/fake-visitors', { method: 'POST', body: JSON.stringify({ count: 5 }) });
    await poll();
    demo.close();
  });

  document.getElementById('dash-tabs').addEventListener('click', event => {
    const tab = event.target.closest('[data-view]');
    if (!tab) return;
    view = tab.dataset.view;
    document.querySelectorAll('#dash-tabs [data-view]').forEach(b => b.classList.toggle('active', b === tab));
    document.querySelectorAll('.dash-view').forEach(el => { el.hidden = el.dataset.view !== view; });
    lastIncidentRender = null;
    if (view === 'admin') loadAdmin().catch(err => alert(err.message));
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
    try {
      await api(`/api/incidents/${encodeURIComponent(selectedIncident)}/notes`, {
        method: 'POST',
        body: JSON.stringify({ text: form.text.value, status: form.status.value || null })
      });
    } catch (err) {
      return alert(err.message);
    }
    form.reset();
    lastIncidentRender = null;
    await poll();
  });

  document.getElementById('review-table').addEventListener('click', async event => {
    const button = event.target.closest('[data-review]');
    if (!button) return;
    if (button.dataset.review === 'revoked' && !confirm('Revoke this temporary pass? Gates will refuse it after their next sync.')) return;
    button.disabled = true;
    await api('/api/reviews', {
      method: 'POST',
      body: JSON.stringify({ passId: button.dataset.pass, decision: button.dataset.review })
    }).catch(err => alert(err.message));
    await poll();
  });

  document.getElementById('feed-filters').addEventListener('click', event => {
    const chip = event.target.closest('[data-filter]');
    if (!chip) return;
    filter = chip.dataset.filter;
    renderFeed();
  });

  document.getElementById('alerts').addEventListener('click', async event => {
    const button = event.target.closest('[data-ack]');
    if (!button) return;
    let note = null;
    if (button.dataset.ack !== 'open') {
      note = prompt(button.dataset.ack === 'false_alarm' ? 'Why is it a false alarm? (optional)' : 'What was done? (optional)', '');
      if (note === null) return;
    }
    button.disabled = true;
    try {
      await api('/api/alerts/ack', { method: 'POST', body: JSON.stringify({ alertId: button.dataset.alert, status: button.dataset.ack, note }) });
    } catch (err) {
      alert(err.message);
    }
    await poll();
  });
  document.getElementById('alerts').addEventListener('toggle', event => {
    if (event.target.matches('.handled-group details')) handledOpen = event.target.open;
  }, true);

  document.body.addEventListener('click', event => {
    if (event.target.closest('#invites-more')) {
      invitesExpanded = true;
      renderInvites();
      return;
    }
    const temp = event.target.closest('[data-temp-qr]');
    if (temp) {
      const t = state.tempPasses.find(x => x.id === temp.dataset.tempQr);
      if (t?.token) showPass({ id: t.id, name: `${t.name} (temporary)`, token: t.token, temporary: true });
      return;
    }
    const visitQr = event.target.closest('[data-visit-qr]');
    if (visitQr) {
      const visit = state.visits.find(v => v.visitId === visitQr.dataset.visitQr);
      const pass = visit && passFor(visit);
      if (pass) showPass(pass);
      return;
    }
    const rec = event.target.closest('[data-open-record]');
    if (rec) {
      const id = rec.dataset.openRecord;
      openRecords.has(id) ? openRecords.delete(id) : openRecords.add(id);
      renderChecksAndShifts();
    }
  });

  document.getElementById('feed').addEventListener('click', event => {
    if (event.target.closest('#feed-more')) {
      feedExpanded = true;
      renderFeed();
      return;
    }
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

  document.getElementById('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    const setup = document.getElementById('auth-screen').dataset.mode === 'setup';
    const error = document.getElementById('auth-error');
    error.hidden = true;
    try {
      const res = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.fullname.value, username: form.username.value, password: form.password.value })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Sign in failed');
      if (body.user.role === 'officer') throw new Error('That is a security officer account. Officers use the gate app; the control room needs a supervisor or admin.');
      storeToken(body.token);
      form.reset();
      startPolling();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });

  document.getElementById('user-chip').addEventListener('click', () => {
    if (!confirm('Sign out of the control room?')) return;
    storeToken(null);
    me = null;
    showAuth('login');
  });

  document.getElementById('user-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    try {
      await api('/api/users', { method: 'POST', body: JSON.stringify({ name: form.fullname.value, username: form.username.value, password: form.password.value, role: form.role.value }) });
      form.reset();
      await loadAdmin();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('watch-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    try {
      await api('/api/watchlist', { method: 'POST', body: JSON.stringify({ name: form.fullname.value, partialId: form.pid.value, level: form.level.value, reason: form.reason.value }) });
      form.reset();
      await loadAdmin();
    } catch (err) {
      alert(err.message);
    }
  });

  const adminView = document.querySelector('.dash-view[data-view="admin"]');
  adminView.addEventListener('change', async event => {
    const select = event.target.closest('[data-role]');
    if (!select) return;
    try {
      await api(`/api/users/${select.dataset.role}`, { method: 'PATCH', body: JSON.stringify({ role: select.value }) });
    } catch (err) {
      alert(err.message);
    }
    await loadAdmin();
  });
  adminView.addEventListener('click', async event => {
    const reset = event.target.closest('[data-reset-pw]');
    const toggle = event.target.closest('[data-toggle-user]');
    const unwatch = event.target.closest('[data-unwatch]');
    try {
      if (reset) {
        const password = prompt('New temporary password (at least 6 characters). They will be signed out everywhere.');
        if (!password) return;
        await api(`/api/users/${reset.dataset.resetPw}`, { method: 'PATCH', body: JSON.stringify({ password }) });
        alert('Password changed.');
      }
      if (toggle) await api(`/api/users/${toggle.dataset.toggleUser}`, { method: 'PATCH', body: JSON.stringify({ active: toggle.dataset.active !== 'true' }) });
      if (unwatch && confirm('Remove this person from the watchlist?')) await api(`/api/watchlist/${unwatch.dataset.unwatch}`, { method: 'DELETE' });
    } catch (err) {
      alert(err.message);
    }
    if (reset || toggle || unwatch) await loadAdmin();
  });

  const status = await (await fetch('/api/auth/status', { cache: 'no-store' })).json().catch(() => ({}));
  if (status.needsSetup) showAuth('setup');
  else if (!token) showAuth('login');
  else startPolling();
}


if (document.readyState === 'complete') boot();
else window.addEventListener('load', boot);
