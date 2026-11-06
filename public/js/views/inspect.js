import { saveRecord } from '../records.js';
import { mountPhotoPicker } from '../photos.js';
import { esc, icon, toast } from '../ui.js';

const RESULTS = [
  { value: 'pass', label: 'Pass' },
  { value: 'fail', label: 'Fail' },
  { value: 'na', label: 'N/A' }
];

export default async function inspect(root, ctx) {
  const { checklists, checkpoints } = ctx.config;

  function renderPicker() {
    root.innerHTML = `
      <h1 class="page-title">Inspections</h1>
      <p class="muted">Pick a checklist. You can complete it with no signal and it will upload later.</p>
      <ul class="card-list">
        ${checklists
          .map(c => `
            <li>
              <button class="card-button" data-checklist="${esc(c.id)}">
                <span class="card-icon">${icon('clipboard')}</span>
                <span class="card-body"><strong>${esc(c.name)}</strong><small>${c.items.length} checks</small></span>
                ${icon('chevron')}
              </button>
            </li>`)
          .join('')}
      </ul>
    `;
  }

  function renderForm(checklist) {
    const answers = checklist.items.map(item => ({ item, result: null, note: '' }));

    root.innerHTML = `
      <button class="back-link" data-action="back">← All checklists</button>
      <h1 class="page-title">${esc(checklist.name)}</h1>
      <form id="inspection" class="stack">
        <label class="field">
          <span>Area</span>
          <select name="area" required>
            <option value="">Select area…</option>
            ${checkpoints.map(cp => `<option>${esc(cp.name)}</option>`).join('')}
            <option value="__other">Other…</option>
          </select>
        </label>
        <label class="field" data-other hidden>
          <span>Describe the area</span>
          <input name="otherArea" placeholder="e.g. Level 2 east corridor">
        </label>

        <ol class="check-items">
          ${answers
            .map((a, i) => `
              <li class="check-item" data-index="${i}">
                <p>${esc(a.item)}</p>
                <div class="segmented" role="radiogroup">
                  ${RESULTS.map(r => `<button type="button" class="seg seg-${r.value}" data-result="${r.value}" role="radio" aria-checked="false">${r.label}</button>`).join('')}
                </div>
                <input class="check-note" placeholder="What's wrong?" hidden>
              </li>`)
            .join('')}
        </ol>

        <label class="field">
          <span>Notes <em>optional</em></span>
          <textarea name="notes" rows="3" placeholder="Anything else worth recording"></textarea>
        </label>
        <div class="field">
          <span>Photos <em>optional</em></span>
          <div data-photos></div>
        </div>
        <button class="btn btn-primary btn-block btn-large" type="submit">Save inspection</button>
      </form>
    `;

    const form = root.querySelector('#inspection');
    const photos = mountPhotoPicker(root.querySelector('[data-photos]'));
    const otherField = root.querySelector('[data-other]');

    form.area.addEventListener('change', () => {
      otherField.hidden = form.area.value !== '__other';
    });

    root.querySelector('.check-items').addEventListener('click', event => {
      const button = event.target.closest('[data-result]');
      if (!button) return;
      const row = button.closest('.check-item');
      const answer = answers[Number(row.dataset.index)];
      answer.result = button.dataset.result;
      row.dataset.result = answer.result;
      row.classList.remove('needs-answer');
      row.querySelectorAll('[data-result]').forEach(b => b.setAttribute('aria-checked', String(b === button)));
      const note = row.querySelector('.check-note');
      note.hidden = answer.result !== 'fail';
      if (!note.hidden) note.focus();
    });

    root.querySelector('.check-items').addEventListener('input', event => {
      if (!event.target.classList.contains('check-note')) return;
      answers[Number(event.target.closest('.check-item').dataset.index)].note = event.target.value.trim();
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const missing = answers.filter(a => !a.result);
      if (missing.length) {
        root.querySelectorAll('.check-item').forEach((row, i) => row.classList.toggle('needs-answer', !answers[i].result));
        root.querySelector('.needs-answer')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast(`${missing.length} item${missing.length > 1 ? 's' : ''} still to answer`, 'warn');
        return;
      }
      const area = form.area.value === '__other' ? form.otherArea.value.trim() || 'Other' : form.area.value;
      const failed = answers.filter(a => a.result === 'fail');

      await saveRecord('inspection', {
        checklistId: checklist.id,
        checklistName: checklist.name,
        area,
        results: answers,
        failedCount: failed.length,
        notes: form.notes.value.trim(),
        photos: photos.photos
      });

      if (failed.length) {
        sessionStorage.setItem('incidentDraft', JSON.stringify({
          title: `${checklist.name}: ${failed[0].item}`,
          category: 'Equipment fault',
          severity: 'medium',
          area,
          description: failed.map(f => `• ${f.item}${f.note ? ` — ${f.note}` : ''}`).join('\n')
        }));
        toast('Inspection saved. Failed items found, raise an incident?', 'warn');
        renderFollowUp(checklist, failed.length);
      } else {
        toast('Inspection saved', 'ok');
        renderPicker();
      }
    });
  }

  function renderFollowUp(checklist, failedCount) {
    root.innerHTML = `
      <section class="panel hero">
        <span class="eyebrow">Inspection saved</span>
        <h1>${failedCount} item${failedCount > 1 ? 's' : ''} failed</h1>
        <p class="muted">${esc(checklist.name)} flagged problems. Raise an incident so it gets followed up.</p>
        <div class="stack">
          <button class="btn btn-danger btn-block" data-action="raise">${icon('alert')} Raise incident</button>
          <button class="btn btn-ghost btn-block" data-action="back">Not now</button>
        </div>
      </section>
    `;
  }

  root.addEventListener('click', event => {
    const picked = event.target.closest('[data-checklist]');
    if (picked) {
      renderForm(checklists.find(c => c.id === picked.dataset.checklist));
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'back') {
      sessionStorage.removeItem('incidentDraft');
      renderPicker();
    } else if (action === 'raise') {
      ctx.navigate('incident');
    }
  });

  renderPicker();
}
