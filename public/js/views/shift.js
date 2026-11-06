import { allRecords, countPending, setMeta } from '../db.js';
import { saveRecord } from '../records.js';
import { onSiteVisits } from '../visits.js';
import { mountSignaturePad } from '../signature.js';
import { postLabel } from '../config.js';
import { esc, icon, screen, toast, formatTime, formatDuration } from '../ui.js';

export async function shiftSummary(ctx) {
  const since = ctx.guard.signedInAt;
  const mine = (await allRecords()).filter(r => r.createdAt >= since && r.guardId === ctx.guard.id);
  const of = type => mine.filter(r => r.type === type);
  const onSite = await onSiteVisits();

  return {
    shiftStart: since,
    shiftEnd: new Date().toISOString(),
    signIns: of('checkin').length,
    signOuts: of('checkout').length,
    tempPasses: of('checkin').filter(r => r.method === 'temp').map(r => ({ name: r.name, id: r.tempPass?.id, until: r.tempPass?.validTo })),
    refusals: of('denied').map(r => ({ name: r.name, reason: r.reason })),
    spotChecks: of('spotcheck').length,
    spotFailures: of('spotcheck').filter(r => r.result !== 'ok').map(r => ({ name: r.name, result: r.result, zone: r.zoneName })),
    incidents: of('incident').map(r => ({ title: r.title, severity: r.severity })),
    checks: of('inspection').map(r => ({ name: r.checkName, issues: r.faults.length + r.shortages.length })),
    rollCalls: of('muster').map(r => ({ at: r.startedAt, missing: r.missing.length, total: r.total })),
    onSite: onSite.map(v => ({ name: v.name, badge: v.badge, host: v.host, escort: v.escort })),
    itemsOut: onSite.flatMap(v => (v.items || []).filter(i => i.kind === 'issued').map(i => ({ who: v.name, badge: v.badge, item: i.ref ? `${i.name} ${i.ref}` : i.name }))),
    itemsMissing: of('checkout').flatMap(r => (r.itemsMissing || []).map(i => ({ who: r.name, item: i.ref ? `${i.name} ${i.ref}` : i.name }))),
    pendingUpload: await countPending()
  };
}

function section(title, rows, empty = 'None') {
  return `
    <section class="report-section">
      <h3>${esc(title)}</h3>
      ${rows.length ? `<ul>${rows.map(r => `<li>${r}</li>`).join('')}</ul>` : `<p class="muted small">${esc(empty)}</p>`}
    </section>`;
}

export default async function shift(root, ctx) {
  const s = await shiftSummary(ctx);
  let pad;
  let saved = null;

  const step = await screen(root, `
    <a class="back-link" href="#settings">← Shift</a>
    <h1 class="page-title">End-of-shift report</h1>
    <p class="muted small">${esc(ctx.guard.name)} · ${esc(postLabel(ctx.config, ctx.guard))} · ${formatTime(s.shiftStart)}–${formatTime(s.shiftEnd)} (${formatDuration(new Date(s.shiftEnd) - new Date(s.shiftStart))})</p>

    <div class="report-stats">
      <div><strong>${s.signIns}</strong><span>signed in</span></div>
      <div><strong>${s.signOuts}</strong><span>signed out</span></div>
      <div><strong>${s.refusals.length}</strong><span>refused</span></div>
      <div><strong>${s.incidents.length}</strong><span>incidents</span></div>
    </div>

    ${section('Still on site', s.onSite.map(v => `<strong>${esc(v.name)}</strong> ${esc(v.badge || '')} · ${esc(v.host || '')}${v.escort ? ' · escort' : ''}`), 'Nobody')}
    ${section('Items still out', s.itemsOut.map(i => `${esc(i.item)} with <strong>${esc(i.who)}</strong> (${esc(i.badge || '')})`))}
    ${section('Items not returned this shift', s.itemsMissing.map(i => `${esc(i.item)} · ${esc(i.who)}`))}
    ${section('Temporary passes issued', s.tempPasses.map(t => `${esc(t.name)} · ${esc(t.id || '')} until ${formatTime(t.until)}`))}
    ${section('Refusals', s.refusals.map(r => `${esc(r.name || 'Unknown')} · ${esc(r.reason)}`))}
    ${section('Spot checks', [`${s.spotChecks} done`, ...s.spotFailures.map(f => `${esc(f.name || 'Unknown')} · ${esc(f.result.replace('_', ' '))} in ${esc(f.zone)}`)])}
    ${section('Incidents', s.incidents.map(i => `${esc(i.title)} · ${esc(i.severity)}`))}
    ${section('Site checks', s.checks.map(c => `${esc(c.name)} · ${c.issues ? `${c.issues} issue(s)` : 'all clear'}`))}
    ${section('Roll calls', s.rollCalls.map(m => `${formatTime(m.at)} · ${m.total - m.missing}/${m.total} accounted`))}
    ${s.pendingUpload ? `<p class="sync-note is-offline">${icon('cloudOff')} ${s.pendingUpload} record(s) on this device are not uploaded yet. Hand the device over or reconnect before leaving.</p>` : ''}

    <form class="stack" id="handover" onsubmit="return false">
      <label class="field"><span>Handover notes</span><textarea name="notes" rows="4" placeholder="Anything the next officer must know"></textarea></label>
      <label class="field"><span>Incoming officer</span><input name="incoming" autocomplete="off" placeholder="Name of officer taking over"></label>
      <div class="field">
        <span>Your signature</span>
        <div class="signature"><canvas></canvas><button type="button" class="signature-clear" data-clear>Clear</button></div>
      </div>
    </form>
    <button class="btn btn-primary btn-block btn-large" data-step="submit">Submit report</button>
  `, {
    onMount: r => {
      pad = mountSignaturePad(r.querySelector('.signature canvas'));
      r.querySelector('[data-clear]').addEventListener('click', () => pad.clear());
    },
    validate: async (step, r) => {
      if (pad.empty) return toast('Sign the report', 'warn'), false;
      const form = r.querySelector('#handover');
      saved = await saveRecord('shift_report', {
        gate: ctx.guard.gate,
        postName: postLabel(ctx.config, ctx.guard),
        summary: s,
        notes: form.notes.value.trim(),
        incomingOfficer: form.incoming.value.trim() || null,
        signature: pad.toDataURL()
      });
      return true;
    }
  });

  if (step !== 'submit' || !saved) return;
  const next = await screen(root, `
    <section class="verdict verdict-good">
      <span class="verdict-icon">${icon('check')}</span>
      <h1>Report submitted</h1>
      <p>${saved.recordedOffline ? 'Saved on this device. It uploads automatically when the connection is back.' : 'Sent to the control room.'}</p>
    </section>
    <button class="btn btn-primary btn-block btn-large" data-step="signout">End shift and sign out</button>
    <button class="btn btn-ghost btn-block" data-step="stay">Stay signed in</button>
  `);
  if (next === 'signout') {
    await setMeta('guard', null);
    ctx.guard = null;
    ctx.navigate('gate');
  } else {
    ctx.navigate('gate');
  }
}
