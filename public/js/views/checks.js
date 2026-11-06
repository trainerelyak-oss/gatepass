import { recordsByType } from '../db.js';
import { saveRecord } from '../records.js';
import { mountPhotoPicker } from '../photos.js';
import { esc, icon, screen, toast, formatDateTime } from '../ui.js';

export default async function checks(root, ctx) {
  const { config } = ctx;
  let busy = false;

  async function list() {
    const recent = (await recordsByType('inspection')).slice(0, 8);
    root.innerHTML = `
      <a class="back-link" href="#report">← Report</a>
      <h1 class="page-title">Site checks</h1>
      <ul class="card-list">
        ${config.checks.map(c => {
          const last = recent.find(r => r.checkId === c.id);
          return `
            <li>
              <button class="card-button" data-check="${esc(c.id)}">
                <span class="card-icon">${icon(c.id === 'emergency' ? 'siren' : c.id === 'perimeter' ? 'route' : 'shield')}</span>
                <span class="card-body">
                  <strong>${esc(c.name)}</strong>
                  <small>${esc(c.description)}</small>
                  <small>${last ? `Last done ${formatDateTime(last.createdAt)}${last.faults.length || last.shortages.length ? ` · ${last.faults.length + last.shortages.length} issue(s)` : ' · all clear'}` : 'Not done on this device yet'}</small>
                </span>
                ${icon('chevron')}
              </button>
            </li>`;
        }).join('')}
      </ul>
    `;
  }

  async function run(template) {
    busy = true;
    const answers = template.items.map(item => ({ ...item, result: null, count: null, note: '' }));
    let picker;
    let record = null;

    const step = await screen(root, `
      <button class="back-link" data-step="cancel">← All checks</button>
      <h1 class="page-title">${esc(template.name)}</h1>
      <p class="muted small">${esc(template.description)}</p>
      <ol class="check-items">
        ${answers.map((a, i) => `
          <li class="check-item" data-index="${i}">
            <p>${esc(a.label)}</p>
            ${a.type === 'count' ? `
              <div class="count-row">
                <input type="number" inputmode="numeric" min="0" data-count="${i}" placeholder="Count">
                <span class="muted">expected ${a.expected}</span>
              </div>` : `
              <div class="segmented">
                <button type="button" class="seg seg-pass" data-result="ok">OK</button>
                <button type="button" class="seg seg-fail" data-result="fault">Fault</button>
                <button type="button" class="seg seg-na" data-result="na">N/A</button>
              </div>`}
            <input class="check-note" data-note="${i}" placeholder="What's wrong?" hidden>
          </li>`).join('')}
      </ol>
      <label class="field"><span>Notes <em>optional</em></span><textarea name="notes" rows="2"></textarea></label>
      <div class="field"><span>Photos <em>optional</em></span><div data-photos></div></div>
      <button class="btn btn-primary btn-block btn-large" data-step="save">Save check</button>
    `, {
      onMount: r => {
        picker = mountPhotoPicker(r.querySelector('[data-photos]'), { max: 4 });
        r.querySelector('.check-items').addEventListener('click', event => {
          const button = event.target.closest('[data-result]');
          if (!button) return;
          const row = button.closest('.check-item');
          const answer = answers[Number(row.dataset.index)];
          answer.result = button.dataset.result;
          row.dataset.result = answer.result;
          row.classList.remove('needs-answer');
          row.querySelectorAll('[data-result]').forEach(b => b.setAttribute('aria-checked', String(b === button)));
          const note = row.querySelector('.check-note');
          note.hidden = answer.result !== 'fault';
          if (!note.hidden) note.focus();
        });
        r.querySelector('.check-items').addEventListener('input', event => {
          const index = event.target.dataset.count ?? event.target.dataset.note;
          if (index === undefined) return;
          const answer = answers[Number(index)];
          if (event.target.dataset.count !== undefined) {
            answer.count = event.target.value === '' ? null : Number(event.target.value);
            const row = event.target.closest('.check-item');
            const short = answer.count !== null && answer.count < answer.expected;
            row.dataset.result = answer.count === null ? '' : short ? 'fault' : 'ok';
            row.classList.remove('needs-answer');
            const note = row.querySelector('.check-note');
            note.hidden = !short;
            note.placeholder = 'Why short? e.g. 1 extinguisher discharged, sent for refill';
          } else {
            answer.note = event.target.value.trim();
          }
        });
      },
      validate: async (s, r) => {
        if (s === 'cancel') return true;
        const missing = answers.filter(a => (a.type === 'count' ? a.count === null : !a.result));
        if (missing.length) {
          r.querySelectorAll('.check-item').forEach((row, i) => {
            const a = answers[i];
            row.classList.toggle('needs-answer', a.type === 'count' ? a.count === null : !a.result);
          });
          r.querySelector('.needs-answer')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return toast(`${missing.length} item${missing.length > 1 ? 's' : ''} still to check`, 'warn'), false;
        }
        const faults = answers.filter(a => a.type === 'check' && a.result === 'fault').map(a => ({ label: a.label, note: a.note }));
        const shortages = answers.filter(a => a.type === 'count' && a.count < a.expected).map(a => ({ label: a.label, count: a.count, expected: a.expected, note: a.note }));
        record = await saveRecord('inspection', {
          gate: ctx.guard.gate,
          checkId: template.id,
          checkName: template.name,
          results: answers.map(({ type, label, result, count, expected, note }) => ({ type, label, result: type === 'count' ? (count < expected ? 'short' : 'ok') : result, count, expected, note })),
          faults,
          shortages,
          notes: r.querySelector('[name=notes]').value.trim(),
          photos: picker.photos
        });
        return true;
      }
    });

    if (step === 'save' && record && (record.faults.length || record.shortages.length)) {
      const next = await screen(root, `
        <section class="verdict verdict-warn">
          <span class="verdict-icon">${icon('alert')}</span>
          <h1>${record.faults.length + record.shortages.length} issue${record.faults.length + record.shortages.length > 1 ? 's' : ''} found</h1>
          <p>${esc(template.name)} saved. Raise an incident for damage or hazards so it gets followed up.</p>
        </section>
        <ul class="missing-list">
          ${record.faults.map(f => `<li><strong>${esc(f.label)}</strong><small>${esc(f.note || 'Fault')}</small></li>`).join('')}
          ${record.shortages.map(f => `<li><strong>${esc(f.label)}</strong><small>${f.count} of ${f.expected}${f.note ? ` · ${esc(f.note)}` : ''}</small></li>`).join('')}
        </ul>
        <button class="btn btn-danger btn-block btn-large" data-step="incident">${icon('alert')} Raise incident</button>
        <button class="btn btn-ghost btn-block" data-step="done">Not now</button>
      `);
      busy = false;
      if (next === 'incident') {
        sessionStorage.setItem('incidentDraft', JSON.stringify({
          category: template.id === 'emergency' ? 'hazard' : 'damage',
          severity: 'medium',
          title: `${template.name}: ${(record.faults[0] || record.shortages[0]).label}`,
          description: [...record.faults.map(f => `• ${f.label}${f.note ? ` (${f.note})` : ''}`), ...record.shortages.map(s => `• ${s.label}: ${s.count}/${s.expected}${s.note ? ` (${s.note})` : ''}`)].join('\n')
        }));
        ctx.navigate('incidents');
        return;
      }
    } else if (step === 'save') {
      toast(`${template.name} saved, all clear`, 'ok');
    }
    busy = false;
    list();
  }

  root.addEventListener('click', event => {
    if (busy) return;
    const picked = event.target.closest('[data-check]');
    if (picked) run(config.checks.find(c => c.id === picked.dataset.check));
  });

  await list();
}
