import { saveRecord } from '../records.js';
import { mountPhotoPicker } from '../photos.js';
import { esc, toast } from '../ui.js';

const SEVERITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'critical', label: 'Critical' }
];

export default async function incident(root, ctx) {
  const { checkpoints, incidentCategories } = ctx.config;
  const draft = JSON.parse(sessionStorage.getItem('incidentDraft') || 'null') || {};
  sessionStorage.removeItem('incidentDraft');
  const severity = draft.severity || 'medium';
  const knownArea = checkpoints.some(cp => cp.name === draft.area);

  root.innerHTML = `
    <h1 class="page-title">Report incident</h1>
    <p class="muted">Critical and high reports are uploaded first when the connection comes back.</p>
    <form id="incident" class="stack">
      <fieldset class="field">
        <legend>Severity</legend>
        <div class="severity-picker">
          ${SEVERITIES.map(s => `
            <label class="sev sev-${s.value}">
              <input type="radio" name="severity" value="${s.value}" ${s.value === severity ? 'checked' : ''}>
              <span>${s.label}</span>
            </label>`).join('')}
        </div>
      </fieldset>
      <label class="field">
        <span>Type</span>
        <select name="category" required>
          ${incidentCategories.map(c => `<option ${c === draft.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span>What happened?</span>
        <input name="summary" required maxlength="120" placeholder="Short summary" value="${esc(draft.title || '')}">
      </label>
      <label class="field">
        <span>Location</span>
        <select name="area">
          <option value="">Current location</option>
          ${checkpoints.map(cp => `<option ${cp.name === draft.area ? 'selected' : ''}>${esc(cp.name)}</option>`).join('')}
          <option value="__other" ${draft.area && !knownArea ? 'selected' : ''}>Other…</option>
        </select>
      </label>
      <label class="field" data-other ${draft.area && !knownArea ? '' : 'hidden'}>
        <span>Describe the location</span>
        <input name="otherArea" value="${esc(draft.area && !knownArea ? draft.area : '')}">
      </label>
      <label class="field">
        <span>Details</span>
        <textarea name="description" rows="4" placeholder="Who, what, actions taken">${esc(draft.description || '')}</textarea>
      </label>
      <div class="field">
        <span>Photos <em>up to 4</em></span>
        <div data-photos></div>
      </div>
      <button class="btn btn-danger btn-block btn-large" type="submit">Submit report</button>
    </form>
  `;

  const form = root.querySelector('#incident');
  const photos = mountPhotoPicker(root.querySelector('[data-photos]'), { max: 4 });
  const otherField = root.querySelector('[data-other]');

  form.area.addEventListener('change', () => {
    otherField.hidden = form.area.value !== '__other';
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    const area = form.area.value === '__other' ? form.otherArea.value.trim() : form.area.value;
    try {
      await saveRecord('incident', {
        severity: form.severity.value,
        category: form.category.value,
        title: form.summary.value.trim(),
        area: area || null,
        description: form.description.value.trim(),
        photos: photos.photos,
        status: 'open'
      });
      toast('Report saved', 'ok');
      ctx.navigate('log');
    } catch (err) {
      button.disabled = false;
      toast(`Couldn't save report: ${err.message}`, 'error');
    }
  });
}
