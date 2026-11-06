import { getMeta } from '../db.js';
import { subscribe } from '../sync.js';
import { saveRecord } from '../records.js';
import { onSiteVisits } from '../visits.js';
import { typeLabel, zoneList } from '../config.js';
import { esc, icon, toast, formatTime, formatDuration, timeAgo } from '../ui.js';

export default async function onsite(root, ctx) {
  let query = '';
  let filter = 'all';
  let open = null;
  let visits = [];
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
    root.querySelector('.filter-chips').innerHTML = FILTERS.map(f => {
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
                <p class="small"><strong>Zones:</strong> ${esc(zoneList(ctx.config, v.zones))}${v.escort ? ' · escort required' : ''}${v.permitNo ? ` · Permit ${esc(v.permitNo)}` : ''}${v.tempPass ? ` · Temporary pass until ${formatTime(v.tempPass.validTo)}` : ''}</p>
                ${(v.items || []).length ? `
                  <div class="return-list">
                    <span class="small"><strong>Check before they leave</strong></span>
                    ${v.items.map((item, i) => `
                      <label>
                        <input type="checkbox" data-item="${i}">
                        <span>${item.kind === 'issued' ? 'Returned' : 'Leaving with'}: <strong>${esc(item.name)}</strong>${item.ref ? ` ${esc(item.ref)}` : ''}</span>
                      </label>`).join('')}
                  </div>` : ''}
                <button class="btn btn-primary btn-block" data-signout="${esc(v.visitId)}">${icon('logOut')} Sign out here</button>
              </div>` : ''}
          </li>`).join('')
      : `<li class="empty">${query ? 'No one matches that search.' : 'No visitors on site.'}</li>`;
  }

  async function render() {
    visits = await onSiteVisits();
    const cache = await getMeta('siteCache');
    lastCache = cache?.fetchedAt || null;
    root.innerHTML = `
      <div class="page-head">
        <h1 class="page-title">On site now <span class="count-pill">${visits.length}</span></h1>
        <a class="btn btn-secondary" href="#spot">${icon('scan')} Spot check</a>
      </div>
      <p class="muted small">Includes visitors from other gates as of the last sync (${timeAgo(cache?.fetchedAt)}).</p>
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

  root.addEventListener('click', async event => {
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
      const box = signout.closest('.visit');
      const ticked = new Set([...box.querySelectorAll('[data-item]:checked')].map(i => Number(i.dataset.item)));
      const items = visit.items || [];
      const itemsMissing = items.filter((item, i) => item.kind === 'issued' && !ticked.has(i));
      const itemsUnconfirmed = items.filter((item, i) => item.kind === 'declared' && !ticked.has(i));
      if (itemsMissing.length && !confirm(`${itemsMissing.map(i => i.name).join(', ')} not returned. Sign out anyway? The control room will be alerted.`)) return;
      signout.disabled = true;
      await saveRecord('checkout', {
        visitId: visit.visitId,
        name: visit.name,
        badge: visit.badge,
        gate: ctx.guard.gate,
        itemsReturned: items.filter((item, i) => ticked.has(i)),
        itemsMissing,
        itemsUnconfirmed
      });
      toast(itemsMissing.length ? `${visit.name} signed out, items outstanding` : `${visit.name} signed out`, itemsMissing.length ? 'warn' : 'ok');
      open = null;
      visits = await onSiteVisits();
      root.querySelector('.count-pill').textContent = visits.length;
      renderChips();
      renderList();
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
    if (state.cacheUpdatedAt && state.cacheUpdatedAt !== lastCache && !open && !query) render();
  });
  return () => {
    unsubscribe();
    document.removeEventListener('keydown', onKey);
  };
}
