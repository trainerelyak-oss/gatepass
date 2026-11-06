const ICONS = {
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="m9 12 2 2 4-4"/>',
  route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="m9 13 2 2 4-4"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  camera: '<path d="M14.5 4h-5L7.5 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.5l-2-3Z"/><circle cx="12" cy="13" r="3.5"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  sync: '<path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  cloudOff: '<path d="m2 2 20 20"/><path d="M5.8 7.6A6 6 0 0 0 7 19h10.5"/><path d="M21.5 16.5A4.5 4.5 0 0 0 17.5 10h-.7A7 7 0 0 0 9.8 5.2"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
};

export function icon(name, className = 'icon') {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

export function toast(message, tone = 'info') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.classList.add('leaving'), 2800);
  setTimeout(() => el.remove(), 3200);
}

export function formatTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? `Today ${formatTime(iso)}`
    : date.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function timeAgo(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 45000) return 'just now';
  return `${formatDuration(diff)} ago`;
}

export function syncDelay(record) {
  const synced = record.receivedAt || record.syncedAt;
  if (!synced) return null;
  return new Date(synced).getTime() - new Date(record.createdAt).getTime();
}

export function describeRecord(record) {
  switch (record.type) {
    case 'scan':
      return {
        icon: 'pin',
        tone: 'neutral',
        title: record.checkpointName || record.checkpointId,
        subtitle: `Checkpoint ${record.checkpointId} · ${record.method === 'qr' ? 'QR scan' : 'Code entry'}`
      };
    case 'patrol': {
      const visited = record.visited?.length || 0;
      const total = record.total || visited;
      return {
        icon: 'route',
        tone: visited < total ? 'warn' : 'ok',
        title: visited < total ? 'Patrol round incomplete' : 'Patrol round completed',
        subtitle: `${visited}/${total} checkpoints · ${formatDuration(new Date(record.endedAt) - new Date(record.startedAt))}`
      };
    }
    case 'inspection':
      return {
        icon: 'clipboard',
        tone: record.failedCount ? 'warn' : 'ok',
        title: `${record.checklistName} inspection`,
        subtitle: `${record.area || 'No area'} · ${record.failedCount ? `${record.failedCount} item${record.failedCount > 1 ? 's' : ''} failed` : 'All items passed'}`
      };
    case 'incident':
      return {
        icon: 'alert',
        tone: record.severity === 'critical' || record.severity === 'high' ? 'danger' : 'warn',
        title: record.title,
        subtitle: `${record.category} · ${record.severity}`
      };
    default:
      return { icon: 'list', tone: 'neutral', title: record.type, subtitle: '' };
  }
}

export function recordDetails(record) {
  const rows = [];
  if (record.type === 'inspection') {
    rows.push(`<ul class="result-list">${record.results
      .map(r => `<li class="result-${r.result}"><span class="result-tag">${esc(r.result)}</span><span>${esc(r.item)}${r.note ? `<em>${esc(r.note)}</em>` : ''}</span></li>`)
      .join('')}</ul>`);
  }
  if (record.type === 'patrol') {
    rows.push(`<p class="detail-line"><strong>Visited:</strong> ${record.visited.map(v => `${esc(v.name)} (${formatTime(v.at)})`).join(', ') || 'none'}</p>`);
    if (record.missed?.length) rows.push(`<p class="detail-line detail-warn"><strong>Missed:</strong> ${record.missed.map(m => esc(m.name)).join(', ')}</p>`);
  }
  if (record.type === 'incident') {
    if (record.area) rows.push(`<p class="detail-line"><strong>Location:</strong> ${esc(record.area)}</p>`);
    if (record.description) rows.push(`<p class="detail-text">${esc(record.description)}</p>`);
  }
  if (record.notes) rows.push(`<p class="detail-text">${esc(record.notes)}</p>`);
  if (record.photos?.length) {
    rows.push(`<div class="detail-photos">${record.photos.map(src => `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="" loading="lazy"></a>`).join('')}</div>`);
  }
  const meta = [`Recorded ${formatDateTime(record.createdAt)}`];
  if (record.guardName) meta.push(`by ${esc(record.guardName)}`);
  if (record.location) meta.push(`GPS ${record.location.lat}, ${record.location.lng} (±${record.location.accuracy}m)`);
  rows.push(`<p class="detail-meta">${meta.join(' · ')}</p>`);
  return rows.join('');
}
