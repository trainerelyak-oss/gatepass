import { getMeta, recordsByType } from '../db.js';
import { esc, icon, timeAgo } from '../ui.js';

export default async function report(root, ctx) {
  const cache = await getMeta('siteCache');
  const local = await recordsByType('incident');
  const ids = new Set();
  const open = [...local, ...(cache?.incidents || [])]
    .filter(i => !ids.has(i.incidentId) && ids.add(i.incidentId))
    .filter(i => !['closed', 'false_alarm'].includes(i.currentStatus || i.status))
    .slice(0, 4);
  const lastChecks = (await recordsByType('inspection')).slice(0, 1);

  root.innerHTML = `
    <h1 class="page-title">Report</h1>
    <div class="hub">
      <a class="hub-card hub-danger" href="#incidents" data-new>
        ${icon('alert')}
        <span><strong>Report an incident</strong><small>Suspicious activity, breach, damage, medical</small></span>
      </a>
      <a class="hub-card" href="#checks">
        ${icon('clipboard')}
        <span><strong>Do a site check</strong><small>${lastChecks.length ? `Last: ${esc(lastChecks[0].checkName)}, ${timeAgo(lastChecks[0].createdAt)}` : 'Restricted areas, emergency kit, perimeter'}</small></span>
      </a>
    </div>
    ${open.length ? `
      <h2 class="section-title">Open incidents</h2>
      <ul class="simple-list">
        ${open.map(i => `
          <li>
            <a class="simple-row" href="#incidents" data-incident="${esc(i.incidentId)}">
              <span class="simple-main"><strong>${esc(i.title)}</strong><small>${esc(i.location || '')}</small></span>
              <span class="simple-side sev-text-${esc(i.severity)}">${esc(i.severity)}</span>
            </a>
          </li>`).join('')}
      </ul>
      <a class="link-button" href="#incidents">All incidents</a>` : ''}
  `;

  root.addEventListener('click', event => {
    if (event.target.closest('[data-new]')) sessionStorage.setItem('incidentNew', '1');
    const row = event.target.closest('[data-incident]');
    if (row) sessionStorage.setItem('incidentOpen', row.dataset.incident);
  });
}
