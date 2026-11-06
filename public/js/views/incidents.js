import { getMeta, recordsByType } from '../db.js';
import { subscribe } from '../sync.js';
import { saveRecord, uid } from '../records.js';
import { onSiteVisits } from '../visits.js';
import { mountPhotoPicker } from '../photos.js';
import { mountSignaturePad } from '../signature.js';
import { photoFingerprint } from '../devicekey.js';
import { zoneName } from '../config.js';
import { esc, icon, screen, toast, formatDateTime, timeAgo } from '../ui.js';

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = [
  { id: 'open', label: 'Open' },
  { id: 'investigating', label: 'Investigating' },
  { id: 'escalated', label: 'Escalated (police / management)' },
  { id: 'closed', label: 'Closed' }
];
const CUSTODY = ['Security office evidence locker', 'Handed to police', 'Returned to owner', 'Photographed only, left in place', 'Other'];
const WITNESS_ROLES = ['Visitor', 'Contractor', 'Staff / tenant', 'Member of public', 'Security officer'];

const statusLabel = id => STATUSES.find(s => s.id === id)?.label.split(' (')[0] || id;

async function loadIncidents() {
  const cache = await getMeta('siteCache');
  const map = new Map();

  for (const s of cache?.incidents || []) {
    map.set(s.incidentId, { ...s, witnesses: [], evidence: [], notes: [...s.notes], local: false });
  }
  for (const r of await recordsByType('incident')) {
    const existing = map.get(r.incidentId) || {};
    map.set(r.incidentId, {
      ...existing,
      ...r,
      currentStatus: existing.currentStatus || r.status,
      notes: existing.notes || [],
      witnessCount: existing.witnessCount || 0,
      evidenceCount: existing.evidenceCount || 0,
      witnesses: [],
      evidence: [],
      local: true
    });
  }

  const children = [
    ...await recordsByType('witness'),
    ...await recordsByType('evidence'),
    ...await recordsByType('incident_note')
  ];
  for (const c of children) {
    const incident = map.get(c.incidentId);
    if (!incident) continue;
    if (c.type === 'witness') incident.witnesses.push(c);
    else if (c.type === 'evidence') incident.evidence.push(c);
    else if (!incident.notes.some(n => n.id === c.id)) {
      incident.notes.push({ id: c.id, text: c.text, status: c.status, author: c.guardName, source: 'device', createdAt: c.createdAt, pending: c.syncStatus === 'pending' });
    }
  }

  for (const incident of map.values()) {
    incident.notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const lastStatus = [...incident.notes].reverse().find(n => n.status);
    incident.currentStatus = lastStatus?.status || incident.currentStatus || incident.status || 'open';
    incident.witnessTotal = Math.max(incident.witnessCount || 0, incident.witnesses.length);
    incident.evidenceTotal = Math.max(incident.evidenceCount || 0, incident.evidence.length);
    incident.lastActivity = [incident.createdAt, ...incident.notes.map(n => n.createdAt), ...incident.witnesses.map(w => w.createdAt), ...incident.evidence.map(e => e.createdAt)].sort().pop();
  }

  return [...map.values()].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}

export default async function incidents(root, ctx) {
  const { config } = ctx;
  let current = null;
  let busy = false;
  let lastCache = null;
  const categoryLabel = id => config.incidentCategories.find(c => c.id === id)?.label || id;

  async function list() {
    current = null;
    const items = await loadIncidents();
    lastCache = (await getMeta('siteCache'))?.fetchedAt || null;
    const open = items.filter(i => i.currentStatus !== 'closed');
    root.innerHTML = `
      <div class="page-head">
        <h1 class="page-title">Incidents</h1>
        <button class="btn btn-danger" data-action="new">${icon('alert')} New</button>
      </div>
      <p class="muted small">${open.length} open · statements, evidence and updates are saved on this device and synced to the control room.</p>
      <ul class="record-list">
        ${items.length ? items.map(i => `
          <li class="record tone-${i.severity === 'critical' || i.severity === 'high' ? 'danger' : i.currentStatus === 'closed' ? 'neutral' : 'warn'}">
            <button class="record-row" data-open="${esc(i.incidentId)}">
              <span class="record-icon">${icon('alert')}</span>
              <span class="record-body">
                <strong>${esc(i.title)}</strong>
                <small>${esc(categoryLabel(i.category))} · ${esc(i.severity)} · ${esc(i.location || '')}</small>
                <span class="record-meta">${formatDateTime(i.createdAt)} · ${i.witnessTotal} witness${i.witnessTotal === 1 ? '' : 'es'} · ${i.evidenceTotal} evidence · ${i.notes.length} update${i.notes.length === 1 ? '' : 's'}</span>
              </span>
              <span class="badge status-${esc(i.currentStatus)}">${esc(statusLabel(i.currentStatus))}</span>
            </button>
          </li>`).join('') : '<li class="empty">No incidents recorded.</li>'}
      </ul>
    `;
  }

  async function create(draft = {}) {
    busy = true;
    const visitors = await onSiteVisits();
    let picker;
    let record = null;
    const step = await screen(root, `
      <button class="back-link" data-step="cancel">← Incidents</button>
      <h1 class="page-title">New incident</h1>
      <form class="stack" id="incident-form" onsubmit="return false">
        <fieldset class="field">
          <legend>Severity</legend>
          <div class="severity-picker">
            ${SEVERITIES.map(s => `<label class="sev sev-${s}"><input type="radio" name="severity" value="${s}" ${s === (draft.severity || 'medium') ? 'checked' : ''}><span>${s[0].toUpperCase() + s.slice(1)}</span></label>`).join('')}
          </div>
        </fieldset>
        <label class="field"><span>Type</span>
          <select name="category">${config.incidentCategories.map(c => `<option value="${esc(c.id)}" ${c.id === draft.category ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
        </label>
        <label class="field"><span>What happened?</span><input name="summary" maxlength="120" placeholder="Short summary" value="${esc(draft.title || '')}"></label>
        <label class="field"><span>Where</span>
          <select name="zone">
            ${config.zones.map(z => `<option value="${esc(z.id)}" ${z.id === draft.location ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}
            <option value="">Somewhere else…</option>
          </select>
        </label>
        <label class="field"><span>Exact location <em>optional</em></span><input name="spot" placeholder="e.g. stairwell 2, level 4 landing"></label>
        <label class="field"><span>Details</span><textarea name="description" rows="4" placeholder="What you saw, who was involved, actions taken">${esc(draft.description || '')}</textarea></label>
        ${visitors.length ? `
          <fieldset class="field">
            <legend>Visitors involved</legend>
            <div class="people-picker">
              ${visitors.map(v => `<label><input type="checkbox" name="people" value="${esc(v.visitId)}" ${draft.people?.includes(v.visitId) ? 'checked' : ''}><span><strong>${esc(v.name)}</strong> <small>${esc(v.badge || '')} · ${esc(v.host || '')}</small></span></label>`).join('')}
            </div>
          </fieldset>` : ''}
        <label class="field"><span>Other people involved <em>optional</em></span><input name="others" placeholder="Names or descriptions" value="${esc(draft.otherPeople || '')}"></label>
        <div class="field"><span>Photos <em>optional</em></span><div data-photos></div></div>
      </form>
      <button class="btn btn-danger btn-block btn-large" data-step="save">Save incident</button>
    `, {
      onMount: r => { picker = mountPhotoPicker(r.querySelector('[data-photos]'), { max: 4 }); },
      validate: async (s, r) => {
        if (s === 'cancel') return true;
        const form = r.querySelector('#incident-form');
        const title = form.summary.value.trim();
        if (!title) return toast('Add a short summary', 'warn'), false;
        const people = [...form.querySelectorAll('[name=people]:checked')].map(i => visitors.find(v => v.visitId === i.value)).filter(Boolean);
        const zone = form.zone.value || null;
        const spot = form.spot.value.trim();
        record = await saveRecord('incident', {
          incidentId: uid(),
          gate: ctx.guard.gate,
          category: form.category.value,
          categoryLabel: categoryLabel(form.category.value),
          severity: form.severity.value,
          title,
          zone,
          location: [zone ? zoneName(config, zone) : null, spot].filter(Boolean).join(' · ') || 'Unspecified',
          description: form.description.value.trim(),
          people: people.map(v => ({ visitId: v.visitId, name: v.name, badge: v.badge })),
          otherPeople: form.others.value.trim() || null,
          photos: picker.photos,
          status: 'open'
        });
        return true;
      }
    });
    busy = false;
    if (step === 'save' && record) {
      toast('Incident saved', 'ok');
      detail(record.incidentId);
    } else list();
  }

  async function detail(id) {
    current = id;
    const incident = (await loadIncidents()).find(i => i.incidentId === id);
    if (!incident) return list();
    lastCache = (await getMeta('siteCache'))?.fetchedAt || null;
    root.innerHTML = `
      <button class="back-link" data-action="list">← Incidents</button>
      <section class="panel incident-head sev-border-${esc(incident.severity)}">
        <span class="eyebrow">${esc(categoryLabel(incident.category))} · ${esc(incident.severity)}</span>
        <h1>${esc(incident.title)}</h1>
        <p class="muted small">${esc(incident.location || '')} · ${formatDateTime(incident.createdAt)} · ${esc(incident.guardName || '')}</p>
        <span class="badge status-${esc(incident.currentStatus)}">${esc(statusLabel(incident.currentStatus))}</span>
        ${incident.description ? `<p class="detail-text">${esc(incident.description)}</p>` : ''}
        ${incident.people?.length || incident.otherPeople ? `<p class="small"><strong>Involved:</strong> ${esc([...(incident.people || []).map(p => `${p.name} (${p.badge})`), incident.otherPeople].filter(Boolean).join(', '))}</p>` : ''}
        ${incident.photos?.length ? `<div class="detail-photos">${incident.photos.map(src => `<img src="${esc(src)}" alt="">`).join('')}</div>` : ''}
      </section>

      <section class="doc-section">
        <div class="doc-head"><h2>Witness statements <span class="count">${incident.witnessTotal}</span></h2><button class="btn btn-secondary" data-action="witness">+ Statement</button></div>
        ${incident.witnesses.length ? incident.witnesses.map(w => `
          <article class="doc-card">
            <strong>${esc(w.name)}</strong> <small class="muted">${esc(w.role)}${w.contact ? ` · ${esc(w.contact)}` : ''}${w.partialId ? ` · ID •••${esc(w.partialId)}` : ''}</small>
            <p class="detail-text">“${esc(w.statement)}”</p>
            ${w.signature ? `<img class="detail-signature" src="${esc(w.signature)}" alt="Signature">` : ''}
            <small class="muted">Taken by ${esc(w.guardName || '')} · ${formatDateTime(w.createdAt)}</small>
          </article>`).join('') : `<p class="muted small">${incident.witnessTotal ? 'Recorded on another device.' : 'None yet.'}</p>`}
      </section>

      <section class="doc-section">
        <div class="doc-head"><h2>Evidence register <span class="count">${incident.evidenceTotal}</span></h2><button class="btn btn-secondary" data-action="evidence">+ Evidence</button></div>
        ${incident.evidence.length ? `<table class="evidence-table"><thead><tr><th>Ref</th><th>Item</th><th>Custody</th></tr></thead><tbody>
          ${incident.evidence.map(e => `
            <tr>
              <td class="mono">${esc(e.ref)}</td>
              <td><strong>${esc(e.description)}</strong><small>Found: ${esc(e.foundAt || '—')} · ${formatDateTime(e.createdAt)}</small>
                ${(e.photoHashes || []).map(h => `<small class="mono fingerprint" title="${esc(h)}">${icon('shield')} ${esc(h.slice(0, 16))}…</small>`).join('')}
              </td>
              <td>${esc(e.custody)}</td>
            </tr>`).join('')}
        </tbody></table>` : `<p class="muted small">${incident.evidenceTotal ? 'Recorded on another device.' : 'None yet.'}</p>`}
      </section>

      <section class="doc-section">
        <div class="doc-head"><h2>Follow-up</h2></div>
        <ul class="timeline">
          ${incident.notes.map(n => `
            <li class="${n.source === 'control' ? 'from-control' : ''}">
              <span class="timeline-meta">${n.source === 'control' ? 'Control room' : esc(n.author || '')} · ${timeAgo(n.createdAt)}${n.pending ? ' · not uploaded yet' : ''}</span>
              ${n.status ? `<span class="badge status-${esc(n.status)}">${esc(statusLabel(n.status))}</span>` : ''}
              ${n.text ? `<p>${esc(n.text)}</p>` : ''}
            </li>`).join('') || '<li class="muted small">No updates yet.</li>'}
        </ul>
        <form class="stack" id="note-form">
          <textarea name="text" rows="2" placeholder="Add an update, e.g. police report no., actions taken"></textarea>
          <div class="inline-form">
            <select name="status"><option value="">Keep status</option>${STATUSES.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('')}</select>
            <button class="btn btn-primary" type="submit">Add update</button>
          </div>
        </form>
      </section>
    `;

    root.querySelector('#note-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      const text = form.text.value.trim();
      const status = form.status.value || null;
      if (!text && !status) return toast('Write an update or change the status', 'warn');
      await saveRecord('incident_note', { incidentId: id, text, status, gate: ctx.guard.gate });
      toast('Update saved', 'ok');
      detail(id);
    });
  }

  async function addWitness(id) {
    busy = true;
    let pad;
    let saved = false;
    const step = await screen(root, `
      <button class="back-link" data-step="cancel">← Back to incident</button>
      <h1 class="page-title">Witness statement</h1>
      <form class="stack" id="witness-form" onsubmit="return false">
        <label class="field"><span>Witness name</span><input name="fullname" autocomplete="off"></label>
        <label class="field"><span>Role</span><select name="role">${WITNESS_ROLES.map(r => `<option>${esc(r)}</option>`).join('')}</select></label>
        <label class="field"><span>Contact number <em>optional</em></span><input name="contact" inputmode="tel" autocomplete="off"></label>
        <label class="field"><span>ID: last 3 digits + letter <em>optional</em></span><input name="pid" class="id-input" maxlength="4" autocomplete="off" placeholder="567A"></label>
        <label class="field"><span>Statement in their own words</span><textarea name="statement" rows="6"></textarea></label>
        <div class="field">
          <span>Witness signature</span>
          <div class="signature"><canvas></canvas><button type="button" class="signature-clear" data-clear>Clear</button></div>
          <small class="muted">The witness confirms the statement above is true and accurate.</small>
        </div>
      </form>
      <button class="btn btn-primary btn-block btn-large" data-step="save">Save statement</button>
    `, {
      onMount: r => {
        pad = mountSignaturePad(r.querySelector('.signature canvas'));
        r.querySelector('[data-clear]').addEventListener('click', () => pad.clear());
      },
      validate: async (s, r) => {
        if (s === 'cancel') return true;
        const form = r.querySelector('#witness-form');
        const name = form.fullname.value.trim();
        const statement = form.statement.value.trim();
        if (!name) return toast('Enter the witness name', 'warn'), false;
        if (!statement) return toast('Record the statement', 'warn'), false;
        if (pad.empty) return toast('The witness needs to sign', 'warn'), false;
        await saveRecord('witness', {
          incidentId: id,
          gate: ctx.guard.gate,
          name,
          role: form.role.value,
          contact: form.contact.value.trim() || null,
          partialId: form.pid.value.trim().toUpperCase() || null,
          statement,
          signature: pad.toDataURL()
        });
        saved = true;
        return true;
      }
    });
    busy = false;
    if (step === 'save' && saved) toast('Statement saved', 'ok');
    detail(id);
  }

  async function addEvidence(id, count) {
    busy = true;
    let picker;
    let saved = false;
    const ref = `EV-${id.slice(0, 4).toUpperCase()}-${String(count + 1).padStart(2, '0')}`;
    const step = await screen(root, `
      <button class="back-link" data-step="cancel">← Back to incident</button>
      <h1 class="page-title">Log evidence <span class="mono muted">${esc(ref)}</span></h1>
      <form class="stack" id="evidence-form" onsubmit="return false">
        <label class="field"><span>Item</span><input name="item" placeholder="e.g. Cut padlock from rooftop door" autocomplete="off"></label>
        <label class="field"><span>Where it was found</span><input name="found" autocomplete="off"></label>
        <label class="field"><span>Chain of custody</span><select name="custody">${CUSTODY.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
        <div class="field">
          <span>Photos</span>
          <div data-photos></div>
          <small class="muted">Each photo gets a SHA-256 fingerprint now. The server re-checks it on upload, so any later change to the image is detectable.</small>
        </div>
      </form>
      <button class="btn btn-primary btn-block btn-large" data-step="save">Add to register</button>
    `, {
      onMount: r => { picker = mountPhotoPicker(r.querySelector('[data-photos]'), { max: 4 }); },
      validate: async (s, r) => {
        if (s === 'cancel') return true;
        const form = r.querySelector('#evidence-form');
        const description = form.item.value.trim();
        if (!description) return toast('Describe the item', 'warn'), false;
        const photos = picker.photos;
        const photoHashes = await Promise.all(photos.map(photoFingerprint));
        await saveRecord('evidence', {
          incidentId: id,
          gate: ctx.guard.gate,
          ref,
          description,
          foundAt: form.found.value.trim() || null,
          custody: form.custody.value,
          photos,
          photoHashes
        });
        saved = true;
        return true;
      }
    });
    busy = false;
    if (step === 'save' && saved) toast(`${ref} added to register`, 'ok');
    detail(id);
  }

  root.addEventListener('click', async event => {
    if (busy) return;
    const openBtn = event.target.closest('[data-open]');
    if (openBtn) return detail(openBtn.dataset.open);
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'new') create();
    if (action === 'list') list();
    if (action === 'witness' && current) addWitness(current);
    if (action === 'evidence' && current) {
      const incident = (await loadIncidents()).find(i => i.incidentId === current);
      addEvidence(current, incident?.evidenceTotal || 0);
    }
  });

  const draft = JSON.parse(sessionStorage.getItem('incidentDraft') || 'null');
  sessionStorage.removeItem('incidentDraft');
  if (draft) create(draft);
  else await list();

  return subscribe(state => {
    if (busy || !state.cacheUpdatedAt || state.cacheUpdatedAt === lastCache) return;
    if (root.querySelector('#note-form textarea')?.value) return;
    current ? detail(current) : list();
  });
}
