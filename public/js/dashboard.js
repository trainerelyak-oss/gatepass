import { esc, icon, describeRecord, recordDetails, formatTime, formatDateTime, formatDuration, timeAgo } from './ui.js';
import { qrSvg } from './qr.js';

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
  overstay: 'clock'
};

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
    { label: 'Passes issued', value: state.invites.length, note: `${state.invites.filter(i => new Date(i.validTo) > Date.now()).length} still valid` }
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
            <td>${esc(typeLabel(v.visitorType))}${v.inducted ? ' <span class="tag">inducted</span>' : ''}</td>
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
              <strong>${esc(config.gates.find(g => g.id === d.gate)?.name || `Gate ${d.gate || '?'}`)}</strong>
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

function renderAll() {
  if (state) {
    renderKpis();
    renderAlerts();
    renderOnSite();
    renderFeed();
    renderDevices();
    renderMuster();
    renderInvites();
  }
  renderLive();
}

async function poll() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    state = await res.json();
    fresh.clear();
    const ids = [...state.feed.map(r => r.id), ...state.alerts.map(a => a.id), ...state.visits.map(v => v.visitId)];
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
          multiEntry: form.multi.checked
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
