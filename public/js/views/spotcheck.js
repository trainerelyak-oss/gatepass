import { getMeta, setMeta } from '../db.js';
import { saveRecord } from '../records.js';
import { verifyPass } from '../verify.js';
import { allVisits, findVisitByBadge } from '../visits.js';
import { cameraAvailable, startScanner, warnNoCamera } from '../scanner.js';
import { zoneName, zoneList, typeLabel } from '../config.js';
import { esc, icon, screen, toast, formatTime } from '../ui.js';

const VERDICTS = {
  ok: { tone: 'good', icon: 'check', title: 'Authorised here' },
  wrong_zone: { tone: 'bad', icon: 'ban', title: 'Not allowed in this zone' },
  not_signed_in: { tone: 'bad', icon: 'alert', title: 'Never signed in' },
  signed_out: { tone: 'bad', icon: 'alert', title: 'Already signed out' },
  expired: { tone: 'warn', icon: 'clock', title: 'Pass has expired' },
  revoked: { tone: 'bad', icon: 'ban', title: 'Pass revoked' },
  invalid: { tone: 'bad', icon: 'ban', title: 'Invalid pass' }
};

async function evaluate(ctx, input, zone) {
  const visits = await allVisits();
  const now = Date.now();

  if (input.badge) {
    const visit = await findVisitByBadge(input.badge);
    if (!visit) {
      return { result: 'not_signed_in', reason: `No one is signed in with badge ${input.badge.toUpperCase()}`, badge: input.badge.toUpperCase() };
    }
    return checkVisit(ctx, visit, zone, now);
  }

  const verdict = await verifyPass(input.token, ctx.config.site.id, now);
  const pass = verdict.pass;
  if (!pass) return { result: 'invalid', reason: verdict.reason };
  if (!verdict.ok && /revoked/i.test(verdict.reason)) return { result: 'revoked', reason: verdict.reason, name: pass.name, passId: pass.id };
  if (!verdict.ok && /expired/i.test(verdict.reason)) return { result: 'expired', reason: verdict.reason, name: pass.name, passId: pass.id };
  if (!verdict.ok) return { result: 'invalid', reason: verdict.reason, name: pass.name, passId: pass.id };

  const matches = visits.filter(v => v.passId === pass.id);
  const inside = matches.find(v => v.status === 'on_site');
  if (inside) return checkVisit(ctx, { ...inside, zones: inside.zones?.length ? inside.zones : pass.zones, escort: inside.escort || pass.escort }, zone, now);
  if (matches.length) {
    const last = matches[0];
    return { result: 'signed_out', reason: `Signed out at Gate ${last.checkoutGate} ${formatTime(last.checkoutAt)}`, name: pass.name, passId: pass.id, visitId: last.visitId, badge: last.badge };
  }
  return { result: 'not_signed_in', reason: 'Valid pass, but no gate has signed this person in. Possible tailgating', name: pass.name, passId: pass.id };
}

function checkVisit(ctx, visit, zone, now) {
  const base = { name: visit.name, passId: visit.passId || null, visitId: visit.visitId, badge: visit.badge, escort: visit.escort, visit };
  if (visit.passValidTo && new Date(visit.passValidTo) < now) {
    return { ...base, result: 'expired', reason: `Pass ended ${formatTime(visit.passValidTo)}. Escort to a gate to sign out` };
  }
  if (!(visit.zones || []).includes(zone)) {
    return { ...base, result: 'wrong_zone', reason: `Allowed: ${zoneList(ctx.config, visit.zones)}` };
  }
  return { ...base, result: 'ok', reason: visit.escort ? 'Escort required. Confirm their escort is present' : `Signed in at Gate ${visit.checkinGate} ${formatTime(visit.checkinAt)}` };
}

export default async function spotcheck(root, ctx) {
  const { config } = ctx;
  let zone = (await getMeta('spotZone')) || config.zones[0]?.id;
  let stopCamera = null;
  let active = true;

  async function run(input) {
    stopCamera?.();
    stopCamera = null;
    const outcome = await evaluate(ctx, input, zone);
    const { visit, ...fields } = outcome;
    await saveRecord('spotcheck', {
      ...fields,
      zone,
      zoneName: zoneName(config, zone),
      gate: ctx.guard.gate,
      method: input.badge ? 'badge' : 'qr'
    });
    const v = VERDICTS[outcome.result];
    const step = await screen(root, `
      <section class="verdict verdict-${v.tone}">
        <span class="verdict-icon">${icon(v.icon)}</span>
        <h1>${v.title}</h1>
        <p>${esc(outcome.reason)}</p>
      </section>
      <section class="panel">
        <dl class="facts">
          <div><dt>Person</dt><dd>${esc(outcome.name || 'Unknown')}</dd></div>
          ${outcome.badge ? `<div><dt>Badge</dt><dd class="mono">${esc(outcome.badge)}</dd></div>` : ''}
          ${visit ? `<div><dt>Type</dt><dd>${esc(typeLabel(config, visit.visitorType))}</dd></div><div><dt>Visiting</dt><dd>${esc(visit.host || '')}</dd></div>` : ''}
          <div><dt>Checked in zone</dt><dd>${esc(zoneName(config, zone))}</dd></div>
        </dl>
      </section>
      ${outcome.result !== 'ok' ? `<button class="btn btn-danger btn-block btn-large" data-step="incident">${icon('alert')} Report incident</button>` : ''}
      <button class="btn btn-primary btn-block btn-large" data-step="again">Check next person</button>
    `);
    if (!active) return;
    if (step === 'incident') {
      sessionStorage.setItem('incidentDraft', JSON.stringify({
        category: outcome.result === 'not_signed_in' ? 'tailgating' : 'breach',
        severity: outcome.result === 'not_signed_in' || outcome.result === 'revoked' ? 'high' : 'medium',
        title: `${v.title}: ${outcome.name || 'unknown person'}`,
        location: zone,
        description: `Spot check in ${zoneName(config, zone)} at ${formatTime(new Date().toISOString())}. ${outcome.reason}.`,
        people: outcome.visitId ? [outcome.visitId] : [],
        otherPeople: outcome.visitId ? '' : outcome.name || ''
      }));
      ctx.navigate('incidents');
      return;
    }
    render();
  }

  async function render() {
    root.innerHTML = `
      <a class="back-link" href="#onsite">← On site</a>
      <h1 class="page-title">Spot check</h1>
      <p class="muted">Check someone inside the building is allowed where they are. Works offline against the signed pass and the sign-in list.</p>
      <label class="field">
        <span>You are in</span>
        <select name="zone">${config.zones.map(z => `<option value="${esc(z.id)}" ${z.id === zone ? 'selected' : ''}>${esc(z.name)}${z.restricted ? ' (restricted)' : ''}</option>`).join('')}</select>
      </label>
      <div class="camera" ${cameraAvailable() ? '' : 'hidden'}>
        <video muted playsinline></video>
        <div class="camera-frame"></div>
        <p class="camera-hint">Scan their pass QR</p>
      </div>
      <form class="field" id="badge-form">
        <span>Or enter their badge number (or paste a pass code)</span>
        <div class="inline-form">
          <input name="badge" class="id-input" autocomplete="off" autocapitalize="characters" placeholder="A001">
          <button class="btn btn-primary" type="submit">Check</button>
        </div>
      </form>
    `;

    root.querySelector('[name=zone]').addEventListener('change', async event => {
      zone = event.target.value;
      await setMeta('spotZone', zone);
    });

    root.querySelector('#badge-form').addEventListener('submit', event => {
      event.preventDefault();
      const value = event.target.badge.value.trim();
      if (!value) return;
      run(/^G[PT]1\./.test(value) ? { token: value } : { badge: value });
    });

    if (cameraAvailable()) {
      try {
        stopCamera = await startScanner(root.querySelector('video'), value => run({ token: value }));
      } catch {
        root.querySelector('.camera').hidden = true;
        warnNoCamera(toast, 'Camera not available. Enter the badge number or paste a pass code.');
      }
    }
  }

  await render();

  return () => {
    active = false;
    stopCamera?.();
  };
}
