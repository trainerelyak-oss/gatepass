import { esc, icon, describeRecord, recordDetails, formatTime, formatDateTime, formatDuration, timeAgo, syncDelay } from './ui.js';

const POLL_MS = 3000;
const STALE_CHECKPOINT_MS = 2 * 60 * 60 * 1000;
const OFFLINE_THRESHOLD_MS = 60 * 1000;

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'incident', label: 'Incidents' },
  { id: 'inspection', label: 'Inspections' },
  { id: 'patrol', label: 'Patrols' },
  { id: 'scan', label: 'Check-ins' }
];

let config = { site: { name: '' }, checkpoints: [] };
let records = [];
let filter = 'all';
let lastFetch = null;
let connected = false;
const seen = new Set();
const fresh = new Set();
const expanded = new Set();
let firstLoad = true;

function wasDelayed(record) {
  const delay = syncDelay(record);
  return record.recordedOffline || (delay !== null && delay > OFFLINE_THRESHOLD_MS);
}

function renderKpis() {
  const today = new Date().toDateString();
  const todays = records.filter(r => new Date(r.createdAt).toDateString() === today);
  const openIncidents = records.filter(r => r.type === 'incident' && r.status !== 'closed');
  const critical = openIncidents.filter(r => r.severity === 'critical' || r.severity === 'high').length;
  const covered = new Set(todays.filter(r => r.type === 'scan').map(r => r.checkpointId)).size;
  const delayed = records.filter(wasDelayed);
  const longest = delayed.reduce((max, r) => Math.max(max, syncDelay(r) || 0), 0);

  const tiles = [
    { label: 'Records today', value: todays.length, note: `${records.length} total` },
    { label: 'Open incidents', value: openIncidents.length, note: critical ? `${critical} high / critical` : 'none urgent', tone: critical ? 'danger' : '' },
    { label: 'Checkpoints covered today', value: `${covered}/${config.checkpoints.length}`, note: covered < config.checkpoints.length ? `${config.checkpoints.length - covered} not visited` : 'full coverage', tone: covered < config.checkpoints.length ? 'warn' : 'ok' },
    { label: 'Captured offline', value: delayed.length, note: longest ? `longest gap ${formatDuration(longest)}` : 'no offline gaps', tone: delayed.length ? 'info' : '' }
  ];

  document.getElementById('kpis').innerHTML = tiles
    .map(t => `
      <div class="kpi ${t.tone ? `kpi-${t.tone}` : ''}">
        <span class="kpi-label">${esc(t.label)}</span>
        <strong class="kpi-value">${esc(t.value)}</strong>
        <span class="kpi-note">${esc(t.note)}</span>
      </div>`)
    .join('');
}

function renderFilters() {
  document.getElementById('feed-filters').innerHTML = FILTERS
    .map(f => {
      const count = f.id === 'all' ? records.length : records.filter(r => r.type === f.id).length;
      return `<button class="chip ${f.id === filter ? 'active' : ''}" data-filter="${f.id}">${f.label} <span class="chip-count">${count}</span></button>`;
    })
    .join('');
}

function renderFeed() {
  const visible = records.filter(r => filter === 'all' || r.type === filter).slice(0, 200);
  const feed = document.getElementById('feed');

  if (!visible.length) {
    feed.innerHTML = `<li class="empty">No records yet. They'll appear here as officers' devices sync.</li>`;
    return;
  }

  feed.innerHTML = visible
    .map(record => {
      const d = describeRecord(record);
      const delay = syncDelay(record);
      const delayed = wasDelayed(record);
      return `
        <li class="record tone-${d.tone} ${fresh.has(record.id) ? 'is-fresh' : ''} ${expanded.has(record.id) ? 'open' : ''}" data-id="${esc(record.id)}">
          <button class="record-row">
            <span class="record-icon">${icon(d.icon)}</span>
            <span class="record-body">
              <strong>${esc(d.title)}</strong>
              <small>${esc(d.subtitle)}</small>
              <span class="record-meta">${esc(record.guardName || 'Unknown officer')} · recorded ${formatDateTime(record.createdAt)}</span>
            </span>
            ${delayed
              ? `<span class="badge badge-offline" title="Received ${formatDateTime(record.receivedAt)}">${icon('cloudOff')} Offline · synced +${formatDuration(delay)}</span>`
              : `<span class="badge badge-synced">${icon('check')} Live</span>`}
          </button>
          ${expanded.has(record.id) ? `<div class="record-details">${recordDetails(record)}<p class="detail-meta">Received by server ${formatDateTime(record.receivedAt)}</p></div>` : ''}
        </li>`;
    })
    .join('');
}

function renderCoverage() {
  document.getElementById('site-name').textContent = config.site.name;
  const lastScan = {};
  for (const r of records) {
    if (r.type !== 'scan') continue;
    if (!lastScan[r.checkpointId] || r.createdAt > lastScan[r.checkpointId].createdAt) lastScan[r.checkpointId] = r;
  }

  document.getElementById('coverage').innerHTML = config.checkpoints
    .map(cp => {
      const scan = lastScan[cp.id];
      const age = scan ? Date.now() - new Date(scan.createdAt) : Infinity;
      const tone = !scan ? 'never' : age > STALE_CHECKPOINT_MS ? 'stale' : 'ok';
      return `
        <li class="coverage-item coverage-${tone}">
          <span class="coverage-dot"></span>
          <span class="coverage-body">
            <strong>${esc(cp.name)}</strong>
            <small>${esc(cp.id)} · ${esc(cp.zone)}</small>
          </span>
          <span class="coverage-time">${scan ? `${formatTime(scan.createdAt)}<small>${esc(scan.guardName || '')}</small>` : 'Not visited'}</span>
        </li>`;
    })
    .join('');
}

function renderOfficers() {
  const officers = {};
  for (const r of records) {
    const key = r.guardId || r.deviceId;
    if (!key) continue;
    const o = officers[key] || (officers[key] = { name: r.guardName || key, id: r.guardId, last: r, count: 0 });
    o.count++;
    if (r.createdAt > o.last.createdAt) o.last = r;
  }
  const list = Object.values(officers).sort((a, b) => b.last.createdAt.localeCompare(a.last.createdAt));
  document.getElementById('officers').innerHTML = list.length
    ? list
        .map(o => {
          const d = describeRecord(o.last);
          return `
            <li class="officer">
              <span class="profile-avatar small-avatar">${icon('user')}</span>
              <span class="officer-body">
                <strong>${esc(o.name)}</strong>
                <small>${esc(o.id || '')} · ${o.count} records</small>
                <small>Last: ${esc(d.title)} · ${timeAgo(o.last.createdAt)}</small>
              </span>
            </li>`;
        })
        .join('')
    : '<li class="empty">No officers have synced yet.</li>';
}

function renderLive() {
  const el = document.querySelector('.live');
  el.dataset.tone = connected ? 'online' : 'offline';
  el.querySelector('.live-label').textContent = connected
    ? `Live · updated ${lastFetch ? timeAgo(lastFetch.toISOString()) : ''}`
    : 'Server unreachable';
}

function renderAll() {
  renderKpis();
  renderFilters();
  renderFeed();
  renderCoverage();
  renderOfficers();
  renderLive();
}

async function poll() {
  try {
    const res = await fetch('/api/records?limit=1000', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    records = data.records;
    fresh.clear();
    for (const r of records) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        if (!firstLoad) fresh.add(r.id);
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

async function boot() {
  document.querySelectorAll('[data-icon]').forEach(el => {
    el.innerHTML = icon(el.dataset.icon);
  });
  try {
    config = await (await fetch('/data/config.json', { cache: 'no-store' })).json();
  } catch {}

  document.getElementById('feed-filters').addEventListener('click', event => {
    const chip = event.target.closest('[data-filter]');
    if (!chip) return;
    filter = chip.dataset.filter;
    renderFilters();
    renderFeed();
  });

  document.getElementById('feed').addEventListener('click', event => {
    const row = event.target.closest('.record-row');
    if (!row) return;
    const id = row.closest('.record').dataset.id;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    fresh.delete(id);
    renderFeed();
  });

  await poll();
  setInterval(poll, POLL_MS);
}

boot();
