import { saveRecord, uid } from '../records.js';
import { verifyPass, checkWatchlist, isPartialId, normaliseId } from '../verify.js';
import { allVisits, nextBadge } from '../visits.js';
import { mountPhotoPicker } from '../photos.js';
import { mountSignaturePad } from '../signature.js';
import { isConnected } from '../sync.js';
import { typeLabel } from '../config.js';
import { esc, icon, screen, toast, formatTime, formatDateTime } from '../ui.js';

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
      <h1>Valid pass</h1>
      <p>Verified on this device${isConnected() ? '' : ' with no connection'}</p>
    </section>
    ${checkList(result.checks)}
    <section class="panel">${passSummary(config, pass)}</section>
    <label class="field">
      <span>Check photo ID: last 3 digits + letter</span>
      <input name="pid" class="id-input" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="567A" inputmode="text">
      <small class="muted">Only the partial NRIC/FIN is recorded, in line with PDPC guidelines.</small>
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
    method: 'pass',
    scanMethod: source.method,
    idCheck,
    photos: []
  };
}

async function walkIn(root, ctx) {
  const { config } = ctx;
  let picker;
  let visitor = null;

  const step = await screen(root, `
    <button class="back-link" data-step="cancel">← Back</button>
    <h1 class="page-title">Walk-in visitor</h1>
    <p class="muted">For visitors without a pass. Works offline.</p>
    <form class="stack" id="walkin" onsubmit="return false">
      <label class="field"><span>Full name</span><input name="fullname" autocomplete="off" placeholder="As shown on ID"></label>
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
      <label class="field"><span>Vehicle no. <em>optional</em></span><input name="vehicle" autocomplete="off" autocapitalize="characters"></label>
      <div class="field"><span>Photo <em>optional</em></span><div data-photos></div></div>
    </form>
    <button class="btn btn-primary btn-block btn-large" data-step="continue">Continue</button>
  `, {
    onMount: r => {
      picker = mountPhotoPicker(r.querySelector('[data-photos]'), { max: 1 });
      r.querySelector('[name=fullname]').focus({ preventScroll: true });
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
      visitor = {
        name,
        partialId,
        visitorType: form.type.value,
        company: form.company.value.trim() || null,
        host,
        vehicle: form.vehicle.value.trim().toUpperCase() || null,
        passId: null,
        method: 'walkin',
        idCheck: 'recorded',
        photos: picker.photos
      };
      return true;
    }
  });

  return step === 'cancel' ? null : visitor;
}

async function induction(root, ctx, visitor) {
  let pad;
  const step = await screen(root, `
    <span class="eyebrow">${icon('hardhat')} Contractor safety induction</span>
    <h1 class="page-title">${esc(visitor.name)}</h1>
    <p class="muted">Read each rule to the contractor and have them confirm.</p>
    <ul class="induction">
      ${ctx.config.induction.map((rule, i) => `
        <li><label><input type="checkbox" data-rule="${i}"><span>${esc(rule)}</span></label></li>`).join('')}
    </ul>
    <p class="muted small">Assembly point: <strong>${esc(ctx.config.assemblyPoint)}</strong></p>
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
      return true;
    }
  });

  if (step === 'cancel') return null;
  return { items: ctx.config.induction, acknowledgedAt: new Date().toISOString(), signature: pad.toDataURL() };
}

export async function runCheckin(root, ctx, source) {
  const visitor = source.kind === 'pass' ? await fromPass(root, ctx, source) : await walkIn(root, ctx);
  if (!visitor) return;

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

  const badge = await nextBadge(ctx.guard.gate);
  const record = await saveRecord('checkin', {
    visitId: uid(),
    badge,
    gate: ctx.guard.gate,
    ...visitor,
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
    </section>
    <p class="sync-note ${record.recordedOffline ? 'is-offline' : ''}">
      ${icon(record.recordedOffline ? 'cloudOff' : 'check')}
      ${record.recordedOffline ? 'Saved on this device. It will reach the control room when the connection is back.' : 'Uploading to the control room now.'}
    </p>
    <button class="btn btn-primary btn-block btn-large" data-step="done">Next visitor</button>
  `);
}
