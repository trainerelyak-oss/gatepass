import { getMeta, setMeta } from '../db.js';
import { saveRecord, uid } from '../records.js';
import { onSiteVisits } from '../visits.js';
import { typeLabel } from '../config.js';
import { esc, icon, toast, formatTime, formatDuration, timeAgo } from '../ui.js';

export default async function muster(root, ctx) {
  const { config } = ctx;
  let roll = await getMeta('activeMuster');
  let query = '';
  let ticker = null;

  async function renderIdle(summary) {
    const visits = await onSiteVisits();
    const cache = await getMeta('siteCache');
    root.innerHTML = `
      ${summary ? summaryHtml(summary) : ''}
      <section class="panel muster-hero">
        <span class="muster-icon">${icon('siren')}</span>
        <h1>Evacuation roll call</h1>
        <p class="muted">Use during a fire alarm or evacuation. Works with no power to the building and no internet. Everyone signed in on this device and other gates (as of ${timeAgo(cache?.fetchedAt)}) goes onto the list.</p>
        <dl class="facts">
          <div><dt>Visitors on site</dt><dd>${visits.length}</dd></div>
          <div><dt>Assembly point</dt><dd>${esc(config.assemblyPoint)}</dd></div>
        </dl>
        <button class="btn btn-danger btn-block btn-large" data-action="start" ${visits.length ? '' : 'disabled'}>${icon('siren')} Start roll call</button>
      </section>
    `;
  }

  function summaryHtml(record) {
    return `
      <section class="verdict ${record.missing.length ? 'verdict-bad' : 'verdict-good'}">
        <span class="verdict-icon">${icon(record.missing.length ? 'alert' : 'check')}</span>
        <h1>${record.missing.length ? `${record.missing.length} unaccounted for` : 'Everyone accounted for'}</h1>
        <p>${record.accounted.length} of ${record.total} accounted · ${formatDuration(new Date(record.endedAt) - new Date(record.startedAt))}</p>
      </section>
      ${record.missing.length ? `
        <ul class="missing-list">
          ${record.missing.map(m => `<li><strong>${esc(m.name)}</strong><small>${esc(m.badge || '')} · ${esc(m.host || '')} · in via Gate ${esc(m.checkinGate)}</small></li>`).join('')}
        </ul>
        <p class="muted small">Pass this list to the fire service. The control room gets it automatically when this device reconnects.</p>` : ''}
    `;
  }

  function renderActive() {
    const accounted = Object.keys(roll.accounted).length;
    const total = roll.people.length;
    const q = query.toLowerCase();
    const people = roll.people
      .filter(p => !q || [p.name, p.badge, p.host, p.company].some(f => String(f || '').toLowerCase().includes(q)))
      .sort((a, b) => Boolean(roll.accounted[a.visitId]) - Boolean(roll.accounted[b.visitId]) || a.name.localeCompare(b.name));

    root.innerHTML = `
      <section class="muster-live">
        <div>
          <span class="eyebrow">Roll call in progress · ${formatTime(roll.startedAt)}</span>
          <h1><span data-count>${accounted}</span> / ${total} accounted</h1>
          <p data-elapsed>${formatDuration(Date.now() - new Date(roll.startedAt))} elapsed</p>
        </div>
        <div class="progress"><span style="width:${total ? Math.round((accounted / total) * 100) : 0}%"></span></div>
      </section>
      <label class="search">
        ${icon('search')}
        <input type="search" placeholder="Search name or badge" value="${esc(query)}">
      </label>
      <ul class="roll-list">
        ${people.map(p => `
          <li>
            <button class="roll-item ${roll.accounted[p.visitId] ? 'is-safe' : ''}" data-person="${esc(p.visitId)}">
              <span class="roll-check">${roll.accounted[p.visitId] ? icon('check') : ''}</span>
              <span class="roll-body">
                <strong>${esc(p.name)}</strong>
                <small>${esc(p.badge || '')} · ${esc(typeLabel(config, p.visitorType))} · ${esc(p.host || '')}</small>
              </span>
              <span class="roll-state">${roll.accounted[p.visitId] ? `Safe ${formatTime(roll.accounted[p.visitId])}` : 'Missing'}</span>
            </button>
          </li>`).join('')}
      </ul>
      <button class="btn btn-primary btn-block btn-large" data-action="finish">Finish roll call</button>
    `;

    root.querySelector('.search input').addEventListener('input', event => {
      query = event.target.value.trim();
      renderActive();
      const input = root.querySelector('.search input');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  async function start() {
    const visits = await onSiteVisits();
    roll = {
      id: uid(),
      startedAt: new Date().toISOString(),
      people: visits.map(({ visitId, name, badge, visitorType, company, host, checkinGate }) => ({ visitId, name, badge, visitorType, company, host, checkinGate })),
      accounted: {}
    };
    await setMeta('activeMuster', roll);
    navigator.vibrate?.([200, 100, 200]);
    renderActive();
  }

  async function finish() {
    const missing = roll.people.filter(p => !roll.accounted[p.visitId]);
    if (missing.length && !confirm(`${missing.length} people still unaccounted for. Finish the roll call?`)) return;
    const record = await saveRecord('muster', {
      musterId: roll.id,
      gate: ctx.guard.gate,
      startedAt: roll.startedAt,
      endedAt: new Date().toISOString(),
      total: roll.people.length,
      accounted: roll.people.filter(p => roll.accounted[p.visitId]).map(p => ({ visitId: p.visitId, name: p.name, at: roll.accounted[p.visitId] })),
      missing
    });
    roll = null;
    await setMeta('activeMuster', null);
    toast('Roll call saved', 'ok');
    renderIdle(record);
  }

  root.addEventListener('click', async event => {
    const person = event.target.closest('[data-person]');
    if (person && roll) {
      const id = person.dataset.person;
      if (roll.accounted[id]) delete roll.accounted[id];
      else {
        roll.accounted[id] = new Date().toISOString();
        navigator.vibrate?.(40);
      }
      await setMeta('activeMuster', roll);
      renderActive();
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'start') start();
    if (action === 'finish') finish();
  });

  if (roll) renderActive();
  else await renderIdle();

  ticker = setInterval(() => {
    const el = root.querySelector('[data-elapsed]');
    if (el && roll) el.textContent = `${formatDuration(Date.now() - new Date(roll.startedAt))} elapsed`;
  }, 10000);

  return () => clearInterval(ticker);
}
