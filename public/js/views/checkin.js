import { saveRecord, uid } from '../records.js';
import { verifyPass, checkWatchlist, isPartialId, normaliseId } from '../verify.js';
import { allVisits, nextBadge } from '../visits.js';
import { recordsByType } from '../db.js';
import { mountPhotoPicker } from '../photos.js';
import { mountSignaturePad } from '../signature.js';
import { isConnected } from '../sync.js';
import { typeLabel, zoneList, zonePicker, isRestricted } from '../config.js';
import { signTempPass } from '../devicekey.js';
import { qrSvg } from '../qr.js';
import { esc, icon, screen, toast, formatTime, formatDateTime } from '../ui.js';

const TEMP_CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function tempCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `T${[...bytes].map(b => TEMP_CODE[b % TEMP_CODE.length]).join('')}`;
}

function checkedValues(root, name) {
  return [...root.querySelectorAll(`input[name="${name}"]:checked`)].map(i => i.value);
}

function checkList(checks) {
  return `
    <ul class="checks">
      ${checks.map(c => `
        <li class="${c.ok ? 'pass' : 'fail'}">
          <span class="check-mark">${icon(c.ok ? 'check' : 'x')}</span>
          <span><strong>${esc(c.label)}</strong><small>${esc(c.detail)}</small></span>
        </li>`).join('')}
    </ul>`;
}

function passSummary(config, pass) {
  return `
    <dl class="facts">
      <div><dt>Visitor</dt><dd>${esc(pass.name)}</dd></div>
      <div><dt>Type</dt><dd>${esc(typeLabel(config, pass.type))}</dd></div>
      ${pass.company ? `<div><dt>Company</dt><dd>${esc(pass.company)}</dd></div>` : ''}
      <div><dt>Visiting</dt><dd>${esc(pass.host)}</dd></div>
      <div><dt>Valid</dt><dd>${formatTime(pass.validFrom)} – ${formatTime(pass.validTo)}</dd></div>
      <div><dt>Zones</dt><dd>${esc(zoneList(config, pass.zones))}${pass.escort ? ' · <strong>escort required</strong>' : ''}</dd></div>
      <div><dt>Pass</dt><dd class="mono">${esc(pass.id)} · ${pass.multiEntry ? 'multi-entry' : 'single entry'}</dd></div>
    </dl>`;
}

async function refuse(root, ctx, details) {
  await saveRecord('denied', { gate: ctx.guard.gate, ...details });
  toast('Refusal logged and reported', 'warn');
}

async function checkPassUsage(result) {
  if (!result.ok) return;
  const visits = await allVisits();
  const pass = result.pass;
  if (pass.multiEntry) {
    const inside = visits.find(v => v.passId === pass.id && v.status === 'on_site');
    result.checks.push(inside
      ? { ok: false, label: 'Not already on site', detail: `Signed in at Gate ${inside.checkinGate} ${formatTime(inside.checkinAt)} and not signed out` }
      : { ok: true, label: 'Not already on site', detail: 'Multi-entry pass' });
  } else {
    const used = visits.find(v => v.passId === pass.id);
    result.checks.push(used
      ? { ok: false, label: 'Not used before', detail: `Already used at Gate ${used.checkinGate} ${formatTime(used.checkinAt)}` }
      : { ok: true, label: 'Not used before', detail: 'Single-entry pass' });
  }
  const failed = result.checks.find(c => !c.ok);
  if (failed) {
    result.ok = false;
    result.reason = failed.detail;
  }
}

async function fromPass(root, ctx, source) {
  const { config } = ctx;
  const result = await verifyPass(source.token, config.site.id);
  if (result.pass && result.checks[0]?.ok) {
    const inside = (await allVisits()).find(v => v.passId === result.pass.id && v.status === 'on_site');
    if (inside) return { signout: inside };
  }
  await checkPassUsage(result);

  if (!result.ok) {
    await saveRecord('denied', {
      gate: ctx.guard.gate,
      reason: result.reason,
      name: result.pass?.name || null,
      passId: result.pass?.id || null,
      method: source.method
    });
    await screen(root, `
      <section class="verdict verdict-bad">
        <span class="verdict-icon">${icon('ban')}</span>
        <h1>Do not admit</h1>
        <p>${esc(result.reason)}</p>
      </section>
      ${result.checks.length ? checkList(result.checks) : ''}
      ${result.pass ? `<section class="panel">${passSummary(config, result.pass)}</section>` : ''}
      <p class="muted small">This refusal has been logged${isConnected() ? ' and sent to the control room' : ' and will reach the control room when the device reconnects'}.</p>
      <button class="btn btn-primary btn-block btn-large" data-step="done">Back to gate</button>
    `);
    return null;
  }

  const pass = result.pass;
  let partialId = null;
  const step = await screen(root, `
    <section class="verdict verdict-good">
      <span class="verdict-icon">${icon('check')}</span>
      <h1>${esc(pass.name)}</h1>
      <p>Valid pass · visiting ${esc(pass.host)} · until ${formatTime(pass.validTo)}</p>
    </section>
    <details class="why">
      <summary>${result.checks.length} checks passed${isConnected() ? '' : ', offline'}</summary>
      ${checkList(result.checks)}
      <section class="panel">${passSummary(config, pass)}</section>
    </details>
    <label class="field">
      <span>Check photo ID: last 3 digits + letter</span>
      <input name="pid" class="id-input" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="567A" inputmode="text">
      <small class="muted">Only the partial NRIC/FIN is kept (PDPC guidelines).</small>
    </label>
    <button class="btn btn-primary btn-block btn-large" data-step="continue">Continue</button>
    <button class="btn btn-ghost btn-block" data-step="refuse">Refuse entry</button>
  `, {
    onMount: r => r.querySelector('[name=pid]').focus({ preventScroll: true }),
    validate: (s, r) => {
      if (s === 'refuse') return true;
      const value = normaliseId(r.querySelector('[name=pid]').value);
      if (!isPartialId(value)) {
        toast('Enter the last 3 digits and letter, e.g. 567A', 'warn');
        return false;
      }
      partialId = value;
      return true;
    }
  });

  if (step === 'refuse') {
    await refuse(root, ctx, { reason: 'Refused by officer', name: pass.name, passId: pass.id });
    return null;
  }

  const idCheck = pass.partialId ? (pass.partialId === partialId ? 'match' : 'mismatch') : 'recorded';
  if (idCheck === 'mismatch') {
    const decision = await screen(root, `
      <section class="verdict verdict-warn">
        <span class="verdict-icon">${icon('alert')}</span>
        <h1>ID doesn't match</h1>
        <p>Pass was issued for ID ending <strong>${esc(pass.partialId)}</strong>, but the ID shown ends <strong>${esc(partialId)}</strong>.</p>
      </section>
      <button class="btn btn-danger btn-block btn-large" data-step="refuse">Refuse entry</button>
      <button class="btn btn-ghost btn-block" data-step="override">Admit anyway (flagged to control room)</button>
    `);
    if (decision === 'refuse') {
      await refuse(root, ctx, { reason: 'ID did not match pass', name: pass.name, passId: pass.id, partialId });
      return null;
    }
  }

  return {
    name: pass.name,
    partialId,
    visitorType: pass.type,
    company: pass.company,
    host: pass.host,
    passId: pass.id,
    passValidTo: pass.validTo,
    multiEntry: pass.multiEntry,
    zones: pass.zones?.length ? pass.zones : config.defaultZones?.[pass.type] || [],
    escort: pass.escort,
    method: 'pass',
    scanMethod: source.method,
    idCheck,
    photos: []
  };
}

async function pastVisitors() {
  const byName = new Map();
  for (const r of await recordsByType('checkin')) {
    const key = r.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, r);
  }
  return byName;
}

async function walkIn(root, ctx, temporary = false, prefill = null) {
  const { config } = ctx;
  const past = await pastVisitors();
  let picker;
  let visitor = null;
  const maxHours = config.tempAccess?.maxHours || 4;
  const durations = [1, 2, 4, 8].filter(h => h <= maxHours);

  const step = await screen(root, `
    <button class="back-link" data-step="cancel">← Back</button>
    <h1 class="page-title">${temporary ? 'Temporary access' : 'Walk-in visitor'}</h1>
    <p class="muted">${temporary
      ? `Issue a short-term pass signed by this device. Other gates can verify it offline. The control room reviews every temporary pass after sync.`
      : 'For visitors without a pass. Works offline.'}</p>
    <form class="stack" id="walkin" onsubmit="return false">
      <label class="field"><span>Full name</span><input name="fullname" autocomplete="off" placeholder="As shown on ID" list="past-visitors"></label>
      <datalist id="past-visitors">${[...past.values()].map(r => `<option value="${esc(r.name)}">${esc([r.company, r.host].filter(Boolean).join(' · '))}</option>`).join('')}</datalist>
      <label class="field">
        <span>ID: last 3 digits + letter</span>
        <input name="pid" class="id-input" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="567A">
      </label>
      <fieldset class="field">
        <legend>Visitor type</legend>
        <div class="type-picker">
          ${config.visitorTypes.map((t, i) => `
            <label><input type="radio" name="type" value="${esc(t.id)}" ${i === 0 ? 'checked' : ''}><span>${esc(t.label)}</span></label>`).join('')}
        </div>
      </fieldset>
      <label class="field"><span>Company <em>optional</em></span><input name="company" autocomplete="off"></label>
      <label class="field"><span>Visiting (person / unit)</span><input name="host" autocomplete="off" placeholder="e.g. Acme Pte Ltd, #12-03"></label>
      ${temporary ? `
        <label class="field"><span>Reason</span>
          <select name="reason">${(config.tempAccess?.reasons || ['Other']).map(r => `<option>${esc(r)}</option>`).join('')}</select>
        </label>
        <fieldset class="field">
          <legend>Valid for</legend>
          <div class="type-picker">
            ${durations.map((h, i) => `<label><input type="radio" name="hours" value="${h}" ${i === durations.length - 1 ? 'checked' : ''}><span>${h} hour${h > 1 ? 's' : ''}</span></label>`).join('')}
          </div>
        </fieldset>` : ''}
      <fieldset class="field">
        <legend>Allowed zones</legend>
        <div data-zones>${zonePicker(config, config.defaultZones?.[config.visitorTypes[0].id] || [])}</div>
      </fieldset>
      <label class="check-row"><input type="checkbox" name="escort"> Must be escorted at all times</label>
      <label class="field"><span>Vehicle no. <em>optional</em></span><input name="vehicle" autocomplete="off" autocapitalize="characters"></label>
      <div class="field"><span>Photo <em>optional</em></span><div data-photos></div></div>
    </form>
    <button class="btn btn-primary btn-block btn-large" data-step="continue">Continue</button>
  `, {
    onMount: r => {
      picker = mountPhotoPicker(r.querySelector('[data-photos]'), { max: 1 });
      r.querySelector('[name=fullname]').focus({ preventScroll: true });
      if (prefill) {
        r.querySelector('[name=fullname]').value = prefill.name || '';
        r.querySelector('[name=pid]').value = prefill.partialId || '';
        r.querySelector('[name=host]').value = prefill.host || '';
      }
      const syncEscort = () => {
        const restricted = checkedValues(r, 'zones').some(z => isRestricted(config, z));
        if (restricted) r.querySelector('[name=escort]').checked = true;
      };
      r.querySelectorAll('input[name=type]').forEach(input => input.addEventListener('change', () => {
        r.querySelector('[data-zones]').innerHTML = zonePicker(config, config.defaultZones?.[input.value] || []);
      }));
      r.querySelector('[data-zones]').addEventListener('change', syncEscort);
      const form = r.querySelector('#walkin');
      form.fullname.addEventListener('change', () => {
        const prior = past.get(form.fullname.value.trim().toLowerCase());
        if (!prior) return;
        form.pid.value = prior.partialId || '';
        form.company.value = prior.company || '';
        form.host.value = prior.host || '';
        form.vehicle.value = prior.vehicle || '';
        const type = form.querySelector(`input[name=type][value="${prior.visitorType}"]`);
        if (type) {
          type.checked = true;
          r.querySelector('[data-zones]').innerHTML = zonePicker(config, prior.zones?.length ? prior.zones : config.defaultZones?.[prior.visitorType] || []);
        }
        form.escort.checked = Boolean(prior.escort);
        toast(`Filled from ${prior.name}'s last visit. Check the ID again.`, 'ok');
      });
    },
    validate: (s, r) => {
      if (s === 'cancel') return true;
      const form = r.querySelector('#walkin');
      const name = form.fullname.value.trim();
      const partialId = normaliseId(form.pid.value);
      const host = form.host.value.trim();
      if (!name) return toast('Enter the visitor\'s name', 'warn'), false;
      if (!isPartialId(partialId)) return toast('ID must be last 3 digits and letter, e.g. 567A', 'warn'), false;
      if (!host) return toast('Who are they visiting?', 'warn'), false;
      const zones = checkedValues(r, 'zones');
      if (!zones.length) return toast('Pick at least one zone', 'warn'), false;
      visitor = {
        zones,
        escort: form.escort.checked,
        tempReason: temporary ? form.reason.value : null,
        tempHours: temporary ? Number(form.hours.value) : null,
        name,
        partialId,
        visitorType: form.type.value,
        company: form.company.value.trim() || null,
        host,
        vehicle: form.vehicle.value.trim().toUpperCase() || null,
        passId: null,
        method: temporary ? 'temp' : 'walkin',
        idCheck: 'recorded',
        photos: picker.photos
      };
      return true;
    }
  });

  return step === 'cancel' ? null : visitor;
}

async function itemsStep(root, ctx, visitor) {
  const presets = ctx.config.itemPresets || { issued: [], declared: [] };
  const items = [];

  const renderItems = r => {
    r.querySelector('.item-list').innerHTML = items.length
      ? items.map((item, i) => `
          <li class="item item-${item.kind}">
            <span class="item-kind">${item.kind === 'issued' ? 'Issued' : 'Declared'}</span>
            <strong>${esc(item.name)}</strong>
            <input data-ref="${i}" value="${esc(item.ref || '')}" placeholder="${item.kind === 'issued' ? 'Card / tag no.' : 'Serial / description'}" autocomplete="off">
            <button type="button" class="item-remove" data-remove="${i}" aria-label="Remove">${icon('x')}</button>
          </li>`).join('')
      : '<li class="empty small">Nothing recorded yet.</li>';
  };

  const step = await screen(root, `
    <span class="eyebrow">${esc(visitor.name)}</span>
    <h1 class="page-title">Items</h1>
    <p class="muted">Record anything handed to the visitor, and equipment they're bringing in. Both are checked again at sign-out.</p>
    <div class="field">
      <span>Issue to visitor</span>
      <div class="chip-row">${presets.issued.map(name => `<button type="button" class="chip" data-add="issued" data-name="${esc(name)}">+ ${esc(name)}</button>`).join('')}</div>
    </div>
    <div class="field">
      <span>Visitor is bringing in</span>
      <div class="chip-row">${presets.declared.map(name => `<button type="button" class="chip" data-add="declared" data-name="${esc(name)}">+ ${esc(name)}</button>`).join('')}</div>
    </div>
    <ul class="item-list"></ul>
    <button class="btn btn-primary btn-block btn-large" data-step="continue">Continue</button>
  `, {
    onMount: r => {
      renderItems(r);
      r.addEventListener('click', event => {
        const add = event.target.closest('[data-add]');
        if (add) {
          items.push({ kind: add.dataset.add, name: add.dataset.name, ref: '' });
          renderItems(r);
          r.querySelector(`[data-ref="${items.length - 1}"]`)?.focus();
          return;
        }
        const remove = event.target.closest('[data-remove]');
        if (remove) {
          items.splice(Number(remove.dataset.remove), 1);
          renderItems(r);
        }
      });
      r.addEventListener('input', event => {
        const ref = event.target.closest('[data-ref]');
        if (ref) items[Number(ref.dataset.ref)].ref = ref.value.trim();
      });
    }
  });
  return step === 'continue' ? items : [];
}

async function induction(root, ctx, visitor) {
  let pad;
  let permitNo = null;
  const step = await screen(root, `
    <span class="eyebrow">${icon('hardhat')} Contractor safety induction</span>
    <h1 class="page-title">${esc(visitor.name)}</h1>
    <p class="muted">Read each rule to the contractor and have them confirm.</p>
    <ul class="induction">
      ${ctx.config.induction.map((rule, i) => `
        <li><label><input type="checkbox" data-rule="${i}"><span>${esc(rule)}</span></label></li>`).join('')}
    </ul>
    <p class="muted small">Assembly point: <strong>${esc(ctx.config.assemblyPoint)}</strong></p>
    <label class="field">
      <span>Permit-to-work no.</span>
      <input name="permit" autocomplete="off" autocapitalize="characters" placeholder="e.g. PTW-2026-0412">
      <small class="muted">Required for contractors working on site.</small>
    </label>
    <div class="field">
      <span>Contractor signature</span>
      <div class="signature">
        <canvas></canvas>
        <button type="button" class="signature-clear" data-clear>Clear</button>
      </div>
    </div>
    <button class="btn btn-primary btn-block btn-large" data-step="continue">Confirm induction</button>
    <button class="btn btn-ghost btn-block" data-step="cancel">Cancel</button>
  `, {
    onMount: r => {
      pad = mountSignaturePad(r.querySelector('.signature canvas'));
      r.querySelector('[data-clear]').addEventListener('click', () => pad.clear());
    },
    validate: (s, r) => {
      if (s === 'cancel') return true;
      const remaining = r.querySelectorAll('.induction input:not(:checked)').length;
      if (remaining) return toast(`${remaining} rule${remaining > 1 ? 's' : ''} not confirmed`, 'warn'), false;
      if (pad.empty) return toast('Contractor needs to sign', 'warn'), false;
      permitNo = r.querySelector('[name=permit]').value.trim().toUpperCase();
      if (!permitNo) return toast('Enter the permit-to-work number', 'warn'), false;
      return true;
    }
  });

  if (step === 'cancel') return null;
  return { items: ctx.config.induction, acknowledgedAt: new Date().toISOString(), signature: pad.toDataURL(), permitNo };
}

export async function signOutFlow(root, ctx, visit) {
  const items = visit.items || [];
  let ticked = new Set();
  const step = await screen(root, `
    <section class="verdict verdict-info">
      <span class="verdict-icon">${icon('logOut')}</span>
      <h1>Sign out ${esc(visit.name)}?</h1>
      <p>${esc(visit.badge || '')} · in since ${formatTime(visit.checkinAt)} at Gate ${esc(visit.checkinGate)}</p>
    </section>
    ${items.length ? `
      <div class="return-list">
        <span class="small"><strong>Check before they leave</strong></span>
        ${items.map((item, i) => `
          <label><input type="checkbox" data-item="${i}"><span>${item.kind === 'issued' ? 'Returned' : 'Leaving with'}: <strong>${esc(item.name)}</strong>${item.ref ? ` ${esc(item.ref)}` : ''}</span></label>`).join('')}
      </div>` : ''}
    <button class="btn btn-primary btn-block btn-large" data-step="out">${icon('logOut')} Sign out</button>
    <button class="btn btn-ghost btn-block" data-step="cancel">Cancel</button>
  `, {
    validate: (s, r) => {
      ticked = new Set([...r.querySelectorAll('[data-item]:checked')].map(i => Number(i.dataset.item)));
      return true;
    }
  });
  if (step !== 'out') return;
  const itemsMissing = items.filter((item, i) => item.kind === 'issued' && !ticked.has(i));
  if (itemsMissing.length && !confirm(`${itemsMissing.map(i => i.name).join(', ')} not returned. Sign out anyway? The control room will be alerted.`)) return;
  const checkout = await saveRecord('checkout', {
    visitId: visit.visitId,
    name: visit.name,
    badge: visit.badge,
    gate: ctx.guard.gate,
    itemsReturned: items.filter((item, i) => ticked.has(i)),
    itemsMissing,
    itemsUnconfirmed: items.filter((item, i) => item.kind === 'declared' && !ticked.has(i))
  });
  const after = await screen(root, `
    <section class="verdict ${itemsMissing.length ? 'verdict-warn' : 'verdict-good'}">
      <span class="verdict-icon">${icon(itemsMissing.length ? 'alert' : 'check')}</span>
      <h1>Signed out</h1>
      <p>${esc(visit.name)}${itemsMissing.length ? ` · ${esc(itemsMissing.map(i => i.name).join(', '))} not returned` : ''}</p>
    </section>
    <button class="btn btn-primary btn-block btn-large" data-step="done">Done</button>
    <button class="btn btn-ghost btn-block" data-step="undo">Undo sign-out</button>
  `, { auto: { step: 'done', seconds: 6 } });
  if (after === 'undo') {
    await saveRecord('checkout_void', { visitId: visit.visitId, checkoutId: checkout.id, name: visit.name, badge: visit.badge, gate: ctx.guard.gate });
    toast(`${visit.name} is signed in again`, 'ok');
  }
}

export async function runCheckin(root, ctx, source) {
  if (source.kind === 'signout') return signOutFlow(root, ctx, source.visit);
  const visitor = source.kind === 'pass' ? await fromPass(root, ctx, source) : await walkIn(root, ctx, source.kind === 'temp', source.prefill);
  if (!visitor) return;
  if (visitor.signout) return signOutFlow(root, ctx, visitor.signout);

  const hit = await checkWatchlist(visitor.name, visitor.partialId);
  if (hit?.level === 'deny') {
    await saveRecord('denied', {
      gate: ctx.guard.gate,
      reason: 'Watchlist match',
      name: visitor.name,
      partialId: visitor.partialId,
      passId: visitor.passId,
      watchlist: hit
    });
    await screen(root, `
      <section class="verdict verdict-bad">
        <span class="verdict-icon">${icon('ban')}</span>
        <h1>Do not admit</h1>
        <p><strong>${esc(visitor.name)}</strong> matches the site watchlist. Do not allow entry. Call your supervisor.</p>
      </section>
      <p class="muted small">Matched on this device without a connection. Personal details on the watchlist are never stored on the phone, only a scrambled fingerprint.</p>
      <button class="btn btn-primary btn-block btn-large" data-step="done">Back to gate</button>
    `);
    return;
  }

  if (hit) {
    const decision = await screen(root, `
      <section class="verdict verdict-warn">
        <span class="verdict-icon">${icon('alert')}</span>
        <h1>Escort required</h1>
        <p><strong>${esc(visitor.name)}</strong> is flagged on the site watchlist. They may enter only with an escort. The control room will be alerted.</p>
      </section>
      <button class="btn btn-primary btn-block btn-large" data-step="continue">Admit with escort</button>
      <button class="btn btn-ghost btn-block" data-step="refuse">Refuse entry</button>
    `);
    if (decision === 'refuse') {
      await refuse(root, ctx, { reason: 'Refused: watchlist alert', name: visitor.name, partialId: visitor.partialId, passId: visitor.passId, watchlist: hit });
      return;
    }
  }

  let inductionRecord = null;
  if (visitor.visitorType === 'contractor' && ctx.config.induction.length) {
    inductionRecord = await induction(root, ctx, visitor);
    if (!inductionRecord) return;
  }

  const needsItems = ['contractor', 'delivery'].includes(visitor.visitorType) || visitor.method === 'temp';
  const items = needsItems ? await itemsStep(root, ctx, visitor) : [];

  let tempPass = null;
  if (visitor.method === 'temp') {
    const now = Date.now();
    const id = tempCode();
    const validTo = new Date(now + visitor.tempHours * 60 * 60 * 1000);
    try {
      const signed = await signTempPass({
        i: id,
        n: visitor.name,
        t: visitor.visitorType,
        h: visitor.host,
        s: ctx.config.site.id,
        f: Math.floor(now / 1000),
        e: Math.floor(validTo.getTime() / 1000),
        m: 0,
        z: visitor.zones,
        ...(visitor.escort ? { x: 1 } : {}),
        p: visitor.partialId,
        r: visitor.tempReason
      });
      tempPass = { id, token: signed.token, keyId: signed.keyId, reason: visitor.tempReason, validTo: validTo.toISOString() };
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  }

  const { tempReason, tempHours, ...fields } = visitor;
  const badge = await nextBadge(ctx.guard.gate);
  const record = await saveRecord('checkin', {
    visitId: uid(),
    badge,
    gate: ctx.guard.gate,
    ...fields,
    passId: tempPass ? tempPass.id : fields.passId,
    passValidTo: tempPass ? tempPass.validTo : fields.passValidTo,
    tempPass,
    items,
    permitNo: inductionRecord?.permitNo || null,
    watchlist: hit || null,
    induction: inductionRecord
  });

  await screen(root, `
    <section class="verdict verdict-good">
      <span class="verdict-icon">${icon('check')}</span>
      <h1>Signed in</h1>
      <p>${esc(record.name)} · ${esc(typeLabel(ctx.config, record.visitorType))}</p>
    </section>
    <section class="badge-card">
      <span>Visitor badge</span>
      <strong>${esc(badge)}</strong>
      <small>Visiting ${esc(record.host)} · ${formatDateTime(record.createdAt)}</small>
      <small>Zones: ${esc(zoneList(ctx.config, record.zones))}${record.escort ? ' · <strong>escort required</strong>' : ''}</small>
      ${items.filter(i => i.kind === 'issued').length ? `<small>Issued: ${esc(items.filter(i => i.kind === 'issued').map(i => i.ref ? `${i.name} ${i.ref}` : i.name).join(', '))}</small>` : ''}
    </section>
    ${tempPass ? `
      <section class="panel temp-pass">
        <span class="eyebrow">Temporary pass ${esc(tempPass.id)} · until ${formatTime(tempPass.validTo)}</span>
        <div class="temp-qr">${qrSvg(tempPass.token)}</div>
        <p class="muted small">Ask the visitor to photograph this QR. Officers can scan it inside the building or at another gate, even offline.</p>
      </section>` : ''}
    <p class="sync-note ${record.recordedOffline ? 'is-offline' : ''}">
      ${icon(record.recordedOffline ? 'cloudOff' : 'check')}
      ${record.recordedOffline ? 'Saved on this device. It will reach the control room when the connection is back.' : 'Uploading to the control room now.'}
    </p>
    <button class="btn btn-primary btn-block btn-large" data-step="done">Next visitor</button>
  `, { auto: { step: 'done', seconds: tempPass ? 30 : 10 } });
}
