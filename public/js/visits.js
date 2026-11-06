import { getMeta, setMeta, recordsByType } from './db.js';

const LOOKAHEAD_MS = 12 * 60 * 60 * 1000;

export async function allVisits() {
  const cache = await getMeta('siteCache');
  const visits = new Map();

  for (const v of cache?.visits || []) {
    visits.set(v.visitId, { ...v, source: 'server' });
  }

  for (const c of await recordsByType('checkin')) {
    if (visits.has(c.visitId)) continue;
    visits.set(c.visitId, {
      visitId: c.visitId,
      badge: c.badge,
      name: c.name,
      visitorType: c.visitorType,
      company: c.company,
      host: c.host,
      passId: c.passId,
      passValidTo: c.passValidTo,
      multiEntry: c.multiEntry,
      zones: c.zones || [],
      escort: Boolean(c.escort),
      items: c.items || [],
      permitNo: c.permitNo || null,
      tempPass: c.tempPass ? { id: c.tempPass.id, validTo: c.tempPass.validTo, reason: c.tempPass.reason } : null,
      checkinAt: c.createdAt,
      checkinGate: c.gate,
      status: 'on_site',
      source: 'device',
      pending: c.syncStatus === 'pending'
    });
  }

  const voided = new Set((await recordsByType('checkout_void')).map(r => r.checkoutId));
  for (const out of await recordsByType('checkout')) {
    if (voided.has(out.id)) continue;
    const v = visits.get(out.visitId);
    if (v && v.status === 'on_site') {
      Object.assign(v, { status: 'left', checkoutAt: out.createdAt, checkoutGate: out.gate });
    }
  }

  return [...visits.values()].sort((a, b) => b.checkinAt.localeCompare(a.checkinAt));
}

export async function findVisitByBadge(badge) {
  const wanted = String(badge || '').trim().toUpperCase();
  return (await allVisits()).find(v => String(v.badge || '').toUpperCase() === wanted && v.status === 'on_site') || null;
}

export async function onSiteVisits() {
  return (await allVisits()).filter(v => v.status === 'on_site');
}

export async function expectedVisitors() {
  const cache = await getMeta('siteCache');
  const visits = await allVisits();
  const now = Date.now();
  return (cache?.invites || [])
    .filter(invite => {
      if (new Date(invite.validTo) <= now) return false;
      if (new Date(invite.validFrom) - now > LOOKAHEAD_MS) return false;
      const uses = visits.filter(v => v.passId === invite.id);
      return invite.multiEntry ? !uses.some(v => v.status === 'on_site') : uses.length === 0;
    })
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
}

export async function findInvite(code) {
  const cache = await getMeta('siteCache');
  const wanted = String(code || '').trim().toUpperCase();
  return (cache?.invites || []).find(i => i.id === wanted) || null;
}

export async function nextBadge(gate) {
  const today = new Date().toDateString();
  const counter = (await getMeta('badgeCounter')) || {};
  const n = counter.day === today ? counter.n + 1 : 1;
  await setMeta('badgeCounter', { day: today, n });
  return `${gate}${String(n).padStart(3, '0')}`;
}
