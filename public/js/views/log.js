import { allRecords } from '../db.js';
import { subscribe } from '../sync.js';
import { esc, icon, describeRecord, recordDetails, formatDateTime, formatTime, formatDuration, syncDelay } from '../ui.js';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Waiting' },
  { id: 'synced', label: 'Uploaded' }
];

export default async function log(root) {
  let filter = 'all';
  let records = [];
  let lastPending = null;
  const open = new Set();

  function syncBadge(record) {
    if (record.syncStatus === 'pending') {
      return `<span class="badge badge-pending">${icon('clock')} Waiting</span>`;
    }
    const delay = syncDelay(record);
    const late = record.recordedOffline && delay > 60000;
    return `<span class="badge badge-synced">${icon('check')} ${late ? `Uploaded ${formatTime(record.syncedAt)} · +${formatDuration(delay)}` : 'Uploaded'}</span>`;
  }

  function render() {
    const visible = records.filter(r => filter === 'all' || r.syncStatus === filter);
    const pending = records.filter(r => r.syncStatus === 'pending').length;

    root.innerHTML = `
      <h1 class="page-title">Shift log</h1>
      <p class="muted">${records.length} record${records.length === 1 ? '' : 's'} on this device · ${pending ? `${pending} waiting to upload` : 'everything uploaded'}</p>
      <div class="chips">
        ${FILTERS.map(f => `<button class="chip ${f.id === filter ? 'active' : ''}" data-filter="${f.id}">${f.label}</button>`).join('')}
      </div>
      ${visible.length ? '' : `<p class="empty">Nothing here yet.</p>`}
      <ul class="record-list">
        ${visible
          .map(record => {
            const d = describeRecord(record);
            return `
              <li class="record tone-${d.tone} ${open.has(record.id) ? 'open' : ''}" data-id="${esc(record.id)}">
                <button class="record-row">
                  <span class="record-icon">${icon(d.icon)}</span>
                  <span class="record-body">
                    <strong>${esc(d.title)}</strong>
                    <small>${esc(d.subtitle)}</small>
                    <span class="record-meta">${formatDateTime(record.createdAt)}${record.recordedOffline ? ' · <span class="offline-tag">recorded offline</span>' : ''}</span>
                  </span>
                  ${syncBadge(record)}
                </button>
                ${open.has(record.id) ? `<div class="record-details">${recordDetails(record)}</div>` : ''}
              </li>`;
          })
          .join('')}
      </ul>
    `;
  }

  async function reload() {
    records = await allRecords();
    render();
  }

  root.addEventListener('click', event => {
    const chip = event.target.closest('[data-filter]');
    if (chip) {
      filter = chip.dataset.filter;
      render();
      return;
    }
    const row = event.target.closest('.record-row');
    if (row) {
      const id = row.closest('.record').dataset.id;
      open.has(id) ? open.delete(id) : open.add(id);
      render();
    }
  });

  await reload();

  return subscribe(state => {
    if (lastPending !== null && state.pending !== lastPending) reload();
    lastPending = state.pending;
  });
}
