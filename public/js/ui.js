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
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  siren: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M5 21h14v-3H5z"/><path d="M12 3V2M4.2 6.2l-.7-.7M19.8 6.2l.7-.7M2 12h1M21 12h1"/>',
  logIn: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  userPlus: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  hardhat: '<path d="M2 18h20"/><path d="M4 18v-3a8 8 0 0 1 16 0v3"/><path d="M10 7V5h4v2"/>'
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
    case 'checkin':
      return {
        icon: 'logIn',
        tone: record.watchlist || record.idCheck === 'mismatch' || record.method === 'temp' ? 'warn' : 'ok',
        title: `${record.name} signed in${record.method === 'temp' ? ' (temporary pass)' : ''}`,
        subtitle: [record.badge, record.visitorType, record.host].filter(Boolean).join(' · ')
      };
    case 'checkout':
      return {
        icon: 'logOut',
        tone: record.itemsMissing?.length ? 'warn' : 'neutral',
        title: `${record.name} signed out`,
        subtitle: [record.badge, `Gate ${record.gate}`].filter(Boolean).join(' · ')
      };
    case 'denied':
      return {
        icon: 'ban',
        tone: 'danger',
        title: `Entry refused${record.name ? `: ${record.name}` : ''}`,
        subtitle: record.reason
      };
    case 'spotcheck':
      return {
        icon: 'scan',
        tone: record.result === 'ok' ? 'ok' : 'danger',
        title: `Spot check: ${record.name || record.badge || 'unknown'}`,
        subtitle: `${record.zoneName} · ${String(record.result).replace('_', ' ')}`
      };
    case 'incident':
      return {
        icon: 'alert',
        tone: record.severity === 'critical' || record.severity === 'high' ? 'danger' : 'warn',
        title: record.title,
        subtitle: `${record.categoryLabel || record.category} · ${record.severity} · ${record.location || ''}`
      };
    case 'witness':
      return { icon: 'user', tone: 'neutral', title: `Witness statement: ${record.name}`, subtitle: record.role };
    case 'evidence':
      return { icon: 'shield', tone: 'neutral', title: `Evidence ${record.ref}: ${record.description}`, subtitle: record.custody };
    case 'incident_note':
      return { icon: 'list', tone: 'neutral', title: record.source === 'control' ? 'Control room update' : 'Incident update', subtitle: [record.status, record.text].filter(Boolean).join(' · ') };
    case 'inspection': {
      const issues = (record.faults?.length || 0) + (record.shortages?.length || 0);
      return { icon: 'clipboard', tone: issues ? 'warn' : 'ok', title: record.checkName, subtitle: issues ? `${issues} issue${issues > 1 ? 's' : ''}` : 'All clear' };
    }
    case 'shift_report':
      return { icon: 'clipboard', tone: 'neutral', title: `Shift report: ${record.guardName || ''}`, subtitle: `${record.summary?.signIns ?? 0} in · ${record.summary?.signOuts ?? 0} out · ${record.summary?.incidents?.length ?? 0} incidents` };
    case 'muster':
      return {
        icon: 'siren',
        tone: record.missing?.length ? 'danger' : 'ok',
        title: 'Evacuation roll call',
        subtitle: `${record.accounted?.length || 0}/${record.total} accounted${record.missing?.length ? ` · ${record.missing.length} missing` : ''}`
      };
    default:
      return { icon: 'list', tone: 'neutral', title: record.type, subtitle: '' };
  }
}

export function recordDetails(record) {
  const rows = [];
  const line = (label, value) => value ? rows.push(`<p class="detail-line"><strong>${esc(label)}:</strong> ${esc(value)}</p>`) : null;

  if (record.type === 'checkin') {
    line('Company', record.company);
    line('Host', record.host);
    line('ID', record.partialId ? `•••${record.partialId}` : null);
    line('Entry by', record.method === 'pass' ? `Pass ${record.passId}` : 'Walk-in registration');
    if (record.idCheck === 'mismatch') rows.push('<p class="detail-line detail-warn">ID did not match the pass. Admitted on override.</p>');
    if (record.watchlist) rows.push(`<p class="detail-line detail-warn">Watchlist match (${esc(record.watchlist.level)}). Control room notified.</p>`);
    if (record.induction) rows.push(`<p class="detail-line"><strong>Safety induction:</strong> acknowledged ${record.induction.items.length} rules</p>`);
    if (record.permitNo) line('Permit to work', record.permitNo);
    if (record.zones?.length) line('Zones', record.zones.join(', ') + (record.escort ? ' (escort required)' : ''));
    if (record.items?.length) line('Items', record.items.map(i => `${i.kind === 'issued' ? 'issued' : 'declared'}: ${i.name}${i.ref ? ` ${i.ref}` : ''}`).join(', '));
    if (record.tempPass) line('Temporary pass', `${record.tempPass.id} · ${record.tempPass.reason} · until ${formatTime(record.tempPass.validTo)}`);
    if (record.induction?.signature) rows.push(`<img class="detail-signature" src="${esc(record.induction.signature)}" alt="Signature">`);
  }
  if (record.type === 'checkout' && record.itemsMissing?.length) {
    rows.push(`<p class="detail-line detail-warn"><strong>Not returned:</strong> ${esc(record.itemsMissing.map(i => i.name).join(', '))}</p>`);
  }
  if (record.type === 'spotcheck') line('Result', record.reason);
  if (record.type === 'incident') {
    line('Location', record.location);
    if (record.description) rows.push(`<p class="detail-text">${esc(record.description)}</p>`);
    if (record.people?.length) line('Involved', record.people.map(p => `${p.name} (${p.badge})`).join(', '));
  }
  if (record.type === 'witness') {
    rows.push(`<p class="detail-text">“${esc(record.statement)}”</p>`);
    if (record.signature) rows.push(`<img class="detail-signature" src="${esc(record.signature)}" alt="Signature">`);
  }
  if (record.type === 'evidence') {
    line('Found', record.foundAt);
    if (record.photoIntegrity?.length) line('Photo integrity', record.photoIntegrity.join(', '));
  }
  if (record.type === 'inspection') {
    for (const f of record.faults || []) rows.push(`<p class="detail-line detail-warn">Fault: ${esc(f.label)}${f.note ? ` (${esc(f.note)})` : ''}</p>`);
    for (const s of record.shortages || []) rows.push(`<p class="detail-line detail-warn">Short: ${esc(s.label)} ${s.count}/${s.expected}</p>`);
  }
  if (record.type === 'shift_report') {
    if (record.notes) rows.push(`<p class="detail-text">${esc(record.notes)}</p>`);
    line('Handed over to', record.incomingOfficer);
  }
  if (record.type === 'muster' && record.missing?.length) {
    rows.push(`<p class="detail-line detail-warn"><strong>Unaccounted:</strong> ${record.missing.map(m => esc(m.name)).join(', ')}</p>`);
  }
  if (record.photos?.length) {
    rows.push(`<div class="detail-photos">${record.photos.map(src => `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="" loading="lazy"></a>`).join('')}</div>`);
  }
  const meta = [`Recorded ${formatDateTime(record.createdAt)}`];
  if (record.gate) meta.push(`Gate ${esc(record.gate)}`);
  if (record.guardName) meta.push(`by ${esc(record.guardName)}`);
  rows.push(`<p class="detail-meta">${meta.join(' · ')}</p>`);
  return rows.join('');
}

export function screen(root, html, { validate, onMount } = {}) {
  root.innerHTML = html;
  window.scrollTo(0, 0);
  onMount?.(root);
  return new Promise(resolve => {
    const handler = async event => {
      const button = event.target.closest('[data-step]');
      if (!button || button.disabled) return;
      event.preventDefault();
      if (validate && !(await validate(button.dataset.step, root))) return;
      root.removeEventListener('click', handler);
      resolve(button.dataset.step);
    };
    root.addEventListener('click', handler);
  });
}
