import { getMeta } from '../db.js';
import { subscribe } from '../sync.js';
import { saveRecord } from '../records.js';
import { onSiteVisits } from '../visits.js';
import { typeLabel } from '../config.js';
import { esc, icon, toast, formatTime, timeAgo } from '../ui.js';

export default async function onsite(root, ctx) {
  let query = '';
  let open = null;
  let visits = [];
  let lastCache = null;

  function matches(v) {
    if (!query) return true;
    const q = query.toLowerCase();
    return [v.name, v.badge, v.host, v.company].some(field => String(field || '').toLowerCase().includes(q));
  }

  function renderList() {
    const list = root.querySelector('.visit-list');
    const visible = visits.filter(matches);
    list.innerHTML = visible.length
      ? visible.map(v => `
          <li class="visit ${open === v.visitId ? 'open' : ''}" data-id="${esc(v.visitId)}">
            <button class="visit-row">
              <span class="visit-badge">${esc(v.badge || '—')}</span>
              <span class="visit-body">
                <strong>${esc(v.name)}</strong>
                <small>${esc(typeLabel(ctx.config, v.visitorType))}${v.company ? ` · ${esc(v.company)}` : ''} · ${esc(v.host || '')}</small>
                <small>In ${formatTime(v.checkinAt)} at Gate ${esc(v.checkinGate)}${v.pending ? ' · <span class="offline-tag">not uploaded yet</span>' : ''}</small>
              </span>
              ${icon('chevron')}
            </button>
            ${open === v.visitId ? `
              <div class="visit-actions">
                <button class="btn btn-primary btn-block" data-signout="${esc(v.visitId)}">${icon('logOut')} Sign out at Gate ${esc(ctx.guard.gate)}</button>
              </div>` : ''}
          </li>`).join('')
      : `<li class="empty">${query ? 'No one matches that search.' : 'No visitors on site.'}</li>`;
  }

  async function render() {
    visits = await onSiteVisits();
    const cache = await getMeta('siteCache');
    lastCache = cache?.fetchedAt || null;
    root.innerHTML = `
      <h1 class="page-title">On site now <span class="count-pill">${visits.length}</span></h1>
      <p class="muted small">Includes visitors from other gates as of the last sync (${timeAgo(cache?.fetchedAt)}).</p>
      <label class="search">
        ${icon('search')}
        <input type="search" placeholder="Name, badge, host or company" value="${esc(query)}">
      </label>
      <ul class="visit-list"></ul>
    `;
    root.querySelector('.search input').addEventListener('input', event => {
      query = event.target.value.trim();
      renderList();
    });
    renderList();
  }

  root.addEventListener('click', async event => {
    const signout = event.target.closest('[data-signout]');
    if (signout) {
      const visit = visits.find(v => v.visitId === signout.dataset.signout);
      if (!visit) return;
      signout.disabled = true;
      await saveRecord('checkout', { visitId: visit.visitId, name: visit.name, badge: visit.badge, gate: ctx.guard.gate });
      toast(`${visit.name} signed out`, 'ok');
      open = null;
      visits = await onSiteVisits();
      root.querySelector('.count-pill').textContent = visits.length;
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

  return subscribe(state => {
    if (state.cacheUpdatedAt && state.cacheUpdatedAt !== lastCache && !open && !query) render();
  });
}
