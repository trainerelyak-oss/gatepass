const byCreated = (a, b) => a.createdAt.localeCompare(b.createdAt);

const time = iso => new Date(iso).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' });

function delayMs(record) {
  if (!record.receivedAt) return 0;
  return new Date(record.receivedAt) - new Date(record.createdAt);
}

function visitFromCheckin(e) {
  return {
    visitId: e.visitId,
    badge: e.badge,
    name: e.name,
    visitorType: e.visitorType,
    company: e.company || null,
    host: e.host || null,
    partialId: e.partialId || null,
    passId: e.passId || e.tempPass?.id || null,
    passValidTo: e.passValidTo || e.tempPass?.validTo || null,
    multiEntry: Boolean(e.multiEntry),
    zones: e.zones || [],
    escort: Boolean(e.escort),
    permitNo: e.permitNo || null,
    items: e.items || [],
    tempPass: e.tempPass || null,
    method: e.method,
    checkinAt: e.createdAt,
    checkinGate: e.gate,
    checkinGuard: e.guardName,
    checkinOffline: Boolean(e.recordedOffline),
    checkinDelayMs: delayMs(e),
    inducted: Boolean(e.induction),
    signature: e.induction?.signature || null,
    photos: e.photos || [],
    idCheck: e.idCheck || null,
    watchlist: e.watchlist || null,
    status: 'on_site',
    checkoutAt: null,
    checkoutGate: null,
    itemsMissing: [],
    flags: []
  };
}

function wasInside(visit, at) {
  return visit.checkinAt <= at && (!visit.checkoutAt || visit.checkoutAt > at);
}

function buildState({ records, invites, devices, reviews }, watchlistReasons, now = new Date()) {
  const events = Object.values(records).sort(byCreated);
  const visits = {};
  const incidents = {};
  const alerts = [];
  const musters = [];
  const checks = [];
  const shiftReports = [];
  const spotChecks = [];

  const alert = a => alerts.push({ offline: false, ...a });

  for (const e of events) {
    switch (e.type) {
      case 'checkin':
        visits[e.visitId] = visitFromCheckin(e);
        break;
      case 'checkout': {
        const visit = visits[e.visitId];
        if (visit && visit.status === 'on_site') {
          visit.status = 'left';
          visit.checkoutAt = e.createdAt;
          visit.checkoutGate = e.gate;
          visit.itemsMissing = e.itemsMissing || [];
        }
        break;
      }
      case 'muster':
        musters.push(e);
        break;
      case 'inspection':
        checks.push(e);
        break;
      case 'shift_report':
        shiftReports.push(e);
        break;
      case 'spotcheck':
        spotChecks.push(e);
        break;
      case 'incident':
        incidents[e.incidentId] = { ...e, witnesses: [], evidence: [], notes: [], currentStatus: e.status || 'open', updatedAt: e.createdAt };
        break;
      case 'witness':
      case 'evidence':
      case 'incident_note': {
        const incident = incidents[e.incidentId];
        if (!incident) break;
        const list = e.type === 'witness' ? incident.witnesses : e.type === 'evidence' ? incident.evidence : incident.notes;
        list.push(e);
        if (e.type === 'incident_note' && e.status) incident.currentStatus = e.status;
        if (e.createdAt > incident.updatedAt) incident.updatedAt = e.createdAt;
        break;
      }
      case 'denied': {
        const forged = /forged|altered/i.test(e.reason || '');
        alert({
          id: `denied-${e.id}`,
          kind: e.watchlist ? 'watchlist' : 'denied',
          severity: e.watchlist?.level === 'deny' || forged ? 'high' : 'medium',
          at: e.createdAt,
          gate: e.gate,
          title: e.watchlist
            ? `Watchlist match refused: ${e.name}`
            : forged ? `Forged pass presented at Gate ${e.gate}` : `Pass rejected at Gate ${e.gate}`,
          detail: e.watchlist ? watchlistReasons[e.watchlist.ref] || 'On site watchlist' : `${e.reason}${e.name ? ` · ${e.name}` : ''}`,
          offline: Boolean(e.recordedOffline)
        });
        break;
      }
    }
  }

  const visitList = Object.values(visits);

  const byPass = {};
  for (const v of visitList) {
    if (v.passId && !v.multiEntry && !v.tempPass) (byPass[v.passId] = byPass[v.passId] || []).push(v);
  }
  for (const [passId, uses] of Object.entries(byPass)) {
    if (uses.length < 2) continue;
    for (const v of uses) v.flags.push('pass_reused');
    alert({
      id: `reuse-${passId}`,
      kind: 'pass_reused',
      severity: 'high',
      at: uses[uses.length - 1].checkinAt,
      gate: uses.map(u => u.checkinGate).join(' + '),
      title: `Single-entry pass ${passId} used ${uses.length} times`,
      detail: uses.map(u => `Gate ${u.checkinGate} ${time(u.checkinAt)}${u.checkinOffline ? ' (offline)' : ''}`).join(' · '),
      offline: uses.some(u => u.checkinOffline),
      visitIds: uses.map(u => u.visitId)
    });
  }

  const tempPasses = [];
  for (const v of visitList) {
    if (v.watchlist) {
      v.flags.push('watchlist');
      alert({ id: `wl-${v.visitId}`, kind: 'watchlist', severity: v.watchlist.level === 'deny' ? 'high' : 'medium', at: v.checkinAt, gate: v.checkinGate, title: `Watchlist person admitted: ${v.name}`, detail: watchlistReasons[v.watchlist.ref] || 'On site watchlist', offline: v.checkinOffline });
    }
    if (v.idCheck === 'mismatch') {
      v.flags.push('id_mismatch');
      alert({ id: `id-${v.visitId}`, kind: 'id_mismatch', severity: 'medium', at: v.checkinAt, gate: v.checkinGate, title: `ID didn't match pass: ${v.name}`, detail: `Admitted by ${v.checkinGuard || 'officer'} after override`, offline: v.checkinOffline });
    }
    if (v.status === 'on_site' && v.passValidTo && new Date(v.passValidTo) < now) {
      v.flags.push('overstay');
      alert({ id: `over-${v.visitId}`, kind: 'overstay', severity: 'medium', at: v.passValidTo, gate: v.checkinGate, title: `${v.name} has overstayed`, detail: `Pass expired ${time(v.passValidTo)}, still signed in` });
    }
    if (v.itemsMissing.length) {
      v.flags.push('items_missing');
      alert({ id: `items-${v.visitId}`, kind: 'items_missing', severity: 'medium', at: v.checkoutAt, gate: v.checkoutGate, title: `${v.name} left without returning items`, detail: v.itemsMissing.map(i => i.ref ? `${i.name} ${i.ref}` : i.name).join(', ') });
    }
    if (v.tempPass) {
      const review = reviews[v.tempPass.id] || null;
      v.tempPass = { ...v.tempPass, review };
      tempPasses.push({ ...v.tempPass, visitId: v.visitId, name: v.name, badge: v.badge, gate: v.checkinGate, guardName: v.checkinGuard, status: v.status, issuedAt: v.checkinAt, offline: v.checkinOffline });
      if (!review) {
        v.flags.push('temp_unreviewed');
        alert({ id: `temp-${v.tempPass.id}`, kind: 'temp_review', severity: 'low', at: v.checkinAt, gate: v.checkinGate, title: `Temporary pass needs review: ${v.name}`, detail: `${v.tempPass.reason} · issued by ${v.checkinGuard || 'officer'} until ${time(v.tempPass.validTo)}`, offline: v.checkinOffline });
      } else if (review.decision === 'revoked') {
        v.flags.push('revoked');
        if (v.status === 'on_site') {
          alert({ id: `revoked-${v.tempPass.id}`, kind: 'revoked', severity: 'high', at: review.at, gate: v.checkinGate, title: `Revoked pass holder still on site: ${v.name}`, detail: `Temporary pass ${v.tempPass.id} revoked by ${review.by}. Locate and escort out` });
        }
      }
    }
  }

  for (const s of spotChecks) {
    if (s.result === 'ok') continue;
    if (s.result === 'not_signed_in' && s.passId) {
      const later = visitList.find(v => v.passId === s.passId && wasInside(v, s.createdAt));
      if (later) {
        s.resolvedOnSync = `Was signed in at Gate ${later.checkinGate} ${time(later.checkinAt)}; this device hadn't synced yet`;
        continue;
      }
    }
    alert({
      id: `spot-${s.id}`,
      kind: 'spotcheck',
      severity: s.result === 'not_signed_in' || s.result === 'revoked' ? 'high' : 'medium',
      at: s.createdAt,
      gate: s.gate,
      title: s.result === 'not_signed_in' ? `Possible tailgating: ${s.name || 'unknown person'} in ${s.zoneName}` : `Spot check failed: ${s.name || 'unknown'} in ${s.zoneName}`,
      detail: s.reason,
      offline: Boolean(s.recordedOffline)
    });
  }

  for (const c of checks) {
    if (!c.faults?.length && !c.shortages?.length) continue;
    alert({
      id: `check-${c.id}`,
      kind: 'check',
      severity: c.shortages?.length ? 'medium' : 'low',
      at: c.createdAt,
      gate: c.gate,
      title: `${c.checkName}: ${[c.faults?.length ? `${c.faults.length} fault${c.faults.length > 1 ? 's' : ''}` : '', c.shortages?.length ? `${c.shortages.length} shortage${c.shortages.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ')}`,
      detail: [...(c.faults || []).map(f => f.label), ...(c.shortages || []).map(s => `${s.label}: ${s.count}/${s.expected}`)].join(' · '),
      offline: Boolean(c.recordedOffline)
    });
  }

  for (const m of musters) {
    if (!m.missing?.length) continue;
    alert({
      id: `muster-${m.id}`,
      kind: 'muster',
      severity: 'high',
      at: m.endedAt || m.createdAt,
      gate: m.gate,
      title: `Roll call: ${m.missing.length} unaccounted for`,
      detail: m.missing.map(p => `${p.name}${p.host ? ` (${p.host})` : ''}`).join(', '),
      offline: Boolean(m.recordedOffline)
    });
  }

  const incidentList = Object.values(incidents).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const i of incidentList) {
    if (i.currentStatus === 'closed') continue;
    if (i.severity === 'critical' || i.severity === 'high') {
      alert({ id: `inc-${i.incidentId}`, kind: 'incident', severity: 'high', at: i.createdAt, gate: i.gate, title: `${i.severity === 'critical' ? 'Critical' : 'High'} incident: ${i.title}`, detail: `${i.categoryLabel || i.category} · ${i.location || ''}`, offline: Boolean(i.recordedOffline) });
    }
  }

  alerts.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  visitList.sort((a, b) => b.checkinAt.localeCompare(a.checkinAt));

  const today = now.toDateString();
  const offlineEvents = events.filter(e => e.recordedOffline);

  return {
    visits: visitList,
    alerts,
    incidents: incidentList,
    tempPasses: tempPasses.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)),
    checks: checks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    shiftReports: shiftReports.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    musters: musters.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    invites: Object.values(invites).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    devices: Object.values(devices).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    feed: events.slice(-200).reverse(),
    stats: {
      onSite: visitList.filter(v => v.status === 'on_site').length,
      today: visitList.filter(v => new Date(v.checkinAt).toDateString() === today).length,
      alerts: alerts.length,
      highAlerts: alerts.filter(a => a.severity === 'high').length,
      openIncidents: incidentList.filter(i => i.currentStatus !== 'closed').length,
      pendingReviews: tempPasses.filter(t => !t.review).length,
      offlineEvents: offlineEvents.length,
      longestOfflineMs: offlineEvents.reduce((max, e) => Math.max(max, delayMs(e)), 0)
    }
  };
}

module.exports = { buildState };
