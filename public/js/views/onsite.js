import { getMeta } from '../db.js';
import { subscribe } from '../sync.js';
import { signOutFlow } from './checkin.js';
import { qrSvg } from '../qr.js';
import { onSiteVisits } from '../visits.js';
import { typeLabel, zoneList } from '../config.js';
import { esc, icon, toast, formatTime, formatDuration, timeAgo } from '../ui.js';

export default async function onsite(root, ctx) {
  let query = '';
  let filter = 'all';
  let busy = false;
  let open = null;
  let visits = [];
  let invites = [];
  let lastCache = null;

  const FILTERS = [
    { id: 'all', label: 'All', test: () => true },
    { id: 'overdue', label: 'Overdue', test: v => minutesLeft(v) !== null && minutesLeft(v) < 0 },
    { id: 'contractor', label: 'Contractors', test: v => v.visitorType === 'contractor' },
    { id: 'escort', label: 'Escort', test: v => v.escort },
    { id: 'items', label: 'Holding items', test: v => (v.items || []).some(i => i.kind === 'issued') },
    { id: 'temp', label: 'Temporary', test: v => Boolean(v.tempPass) }
  ];

  function minutesLeft(v) {
    return v.passValidTo ? Math.round((new Date(v.passValidTo) - Date.now()) / 60000) : null;
  }

  function timeChip(v) {
    const left = minutesLeft(v);
    if (left === null) return '';
    if (left < 0) return `<span class="time-chip is-over">${formatDuration(-left * 60000)} over</span>`;
    if (left <= 30) return `<span class="time-chip is-soon">${formatDuration(left * 60000)} left</span>`;
    return `<span class="time-chip">until ${formatTime(v.passValidTo)}</span>`;
  }

  function matches(v) {
    if (!FILTERS.find(f => f.id === filter).test(v)) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return [v.name, v.badge, v.host, v.company].some(field => String(field || '').toLowerCase().includes(q));
  }

  function sorted(list) {
    return [...list].sort((a, b) => {
      const la = minutesLeft(a);
      const lb = minutesLeft(b);
      const oa = la !== null && la < 0;
      const ob = lb !== null && lb < 0;
      if (oa !== ob) return oa ? -1 : 1;
      return b.checkinAt.localeCompare(a.checkinAt);
    });
  }

  function renderChips() {
    const box = root.querySelector('.filter-chips');
    if (visits.length < 5 && filter === 'all') {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = FILTERS.map(f => {
      const count = visits.filter(f.test).length;
      if (f.id !== 'all' && !count) return '';
      return `<button class="chip ${filter === f.id ? 'active' : ''}" data-filter="${f.id}">${f.label} <span class="chip-count">${count}</span></button>`;
    }).join('');
  }

  function renderList() {
    const list = root.querySelector('.visit-list');
    const visible = sorted(visits.filter(matches));
    list.innerHTML = visible.length
      ? visible.map(v => `
          <li class="visit ${open === v.visitId ? 'open' : ''}" data-id="${esc(v.visitId)}">
            <button class="visit-row">
              <span class="visit-badge">${esc(v.badge || '—')}</span>
              <span class="visit-body">
                <strong>${esc(v.name)} ${timeChip(v)}${v.escort ? '<span class="time-chip is-soon">escort</span>' : ''}</strong>
                <small>${esc(typeLabel(ctx.config, v.visitorType))}${v.company ? ` · ${esc(v.company)}` : ''} · ${esc(v.host || '')}</small>
                <small>In ${formatTime(v.checkinAt)} at Gate ${esc(v.checkinGate)}${v.pending ? ' · <span class="offline-tag">not uploaded yet</span>' : ''}</small>
              </span>
              ${icon('chevron')}
            </button>
            ${open === v.visitId ? `
              <div class="visit-actions">
                <p class="small muted">${esc(zoneList(ctx.config, v.zones))}${v.escort ? ' · escort required' : ''}${v.permitNo ? ` · Permit ${esc(v.permitNo)}` : ''}${(v.items || []).filter(i => i.kind === 'issued').length ? ` · holding ${esc(v.items.filter(i => i.kind === 'issued').map(i => i.name).join(', '))}` : ''}</p>
                ${passToken(v) ? `<button class="btn btn-secondary btn-block" data-show-pass="${esc(v.visitId)}">${icon('qr')} Show pass QR</button>` : ''}
                <button class="btn btn-primary btn-block" data-signout="${esc(v.visitId)}">${icon('logOut')} Sign out</button>
              </div>` : ''}
          </li>`).join('')
      : `<li class="empty">${query ? 'No one matches that search.' : 'No visitors on site.'}</li>`;
  }

  async function render() {
    visits = await onSiteVisits();
    const cache = await getMeta('siteCache');
    invites = cache?.invites || [];
    lastCache = cache?.fetchedAt || null;
    root.innerHTML = `
      <div class="page-head">
        <h1 class="page-title">On site now <span class="count-pill">${visits.length}</span></h1>
        <a class="btn btn-secondary" href="#spot">${icon('scan')} Spot check</a>
      </div>
      <p class="muted small">All gates, as of ${timeAgo(cache?.fetchedAt)}</p>
      <label class="search">
        ${icon('search')}
        <input type="search" placeholder="Name, badge, host or company" value="${esc(query)}">
      </label>
      <div class="chips filter-chips"></div>
      <ul class="visit-list"></ul>
    `;
    root.querySelector('.search input').addEventListener('input', event => {
      query = event.target.value.trim();
      renderList();
    });
    renderChips();
    renderList();
  }

  const onKey = event => {
    if (event.key === '/' && !event.target.closest('input, textarea, select')) {
      event.preventDefault();
      root.querySelector('.search input')?.focus();
    }
  };
  document.addEventListener('keydown', onKey);

  function passToken(v) {
    if (v.tempPass?.token) return v.tempPass.token;
    return invites.find(i => i.id === v.passId)?.token || null;
  }

  root.addEventListener('click', async event => {
    if (busy) return;
    const show = event.target.closest('[data-show-pass]');
    if (show) {
      const v = visits.find(x => x.visitId === show.dataset.showPass);
      const token = v && passToken(v);
      if (!token) return;
      const dialog = document.createElement('dialog');
      dialog.className = 'sheet';
      dialog.innerHTML = `
        <div class="sheet-inner">
          <div class="sheet-head"><h2>${esc(v.name)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></div>
          <p class="muted small">${v.tempPass ? `Temporary pass ${esc(v.tempPass.id)} · until ${formatTime(v.tempPass.validTo)}` : `Pass ${esc(v.passId)}`}. Let the visitor photograph it again, or scan it with another gate.</p>
          <div class="temp-qr center-qr">${qrSvg(token)}</div>
        </div>`;
      document.body.append(dialog);
      dialog.querySelector('[data-close]').onclick = () => dialog.close();
      dialog.addEventListener('close', () => dialog.remove());
      dialog.showModal();
      return;
    }
    const chip = event.target.closest('[data-filter]');
    if (chip) {
      filter = chip.dataset.filter;
      renderChips();
      renderList();
      return;
    }
    const signout = event.target.closest('[data-signout]');
    if (signout) {
      const visit = visits.find(v => v.visitId === signout.dataset.signout);
      if (!visit) return;
      busy = true;
      await signOutFlow(root, ctx, visit);
      busy = false;
      open = null;
      render();
      return;
    }
    const row = event.target.closest('.visit-row');
    if (row) {
      const id = row.closest('.visit').dataset.id;
      open = open === id ? null : id;
      renderList();
    }
  });

  await render();

  const unsubscribe = subscribe(state => {
    if (!busy && state.cacheUpdatedAt && state.cacheUpdatedAt !== lastCache && !open && !query) render();
  });
  return () => {
    unsubscribe();
    document.removeEventListener('keydown', onKey);
  };
}
