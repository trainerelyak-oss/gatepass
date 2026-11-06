const byCreated = (a, b) => a.createdAt.localeCompare(b.createdAt);

function delayMs(record) {
  if (!record.receivedAt) return 0;
  return new Date(record.receivedAt) - new Date(record.createdAt);
}

function buildState({ records, invites, devices }, watchlistReasons, now = new Date()) {
  const events = Object.values(records).sort(byCreated);
  const visits = {};
  const alerts = [];
  const musters = [];

  for (const e of events) {
    if (e.type === 'checkin') {
      visits[e.visitId] = {
        visitId: e.visitId,
        badge: e.badge,
        name: e.name,
        visitorType: e.visitorType,
        company: e.company || null,
        host: e.host || null,
        partialId: e.partialId || null,
        passId: e.passId || null,
        passValidTo: e.passValidTo || null,
        multiEntry: Boolean(e.multiEntry),
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
        checkoutGate: null
      };
    } else if (e.type === 'checkout') {
      const visit = visits[e.visitId];
      if (visit && visit.status === 'on_site') {
        visit.status = 'left';
        visit.checkoutAt = e.createdAt;
        visit.checkoutGate = e.gate;
      }
    } else if (e.type === 'muster') {
      musters.push(e);
    } else if (e.type === 'denied') {
      const reason = e.watchlist ? watchlistReasons[e.watchlist.ref] : null;
      alerts.push({
        id: `denied-${e.id}`,
        kind: e.watchlist ? 'watchlist' : 'denied',
        severity: e.watchlist?.level === 'deny' || /forged|altered/i.test(e.reason || '') ? 'high' : 'medium',
        at: e.createdAt,
        gate: e.gate,
        title: e.watchlist
          ? `Watchlist match refused: ${e.name}`
          : /forged|altered/i.test(e.reason || '') ? `Forged pass presented at Gate ${e.gate}` : `Pass rejected at Gate ${e.gate}`,
        detail: e.watchlist ? reason || 'On site watchlist' : `${e.reason}${e.name ? ` · ${e.name}` : ''}`,
        offline: Boolean(e.recordedOffline)
      });
    }
  }

  const visitList = Object.values(visits);
  const byPass = {};
  for (const v of visitList) {
    if (v.passId && !v.multiEntry) (byPass[v.passId] = byPass[v.passId] || []).push(v);
  }

  for (const [passId, uses] of Object.entries(byPass)) {
    if (uses.length < 2) continue;
    for (const v of uses) v.flags = [...(v.flags || []), 'pass_reused'];
    alerts.push({
      id: `reuse-${passId}`,
      kind: 'pass_reused',
      severity: 'high',
      at: uses[uses.length - 1].checkinAt,
      gate: uses.map(u => u.checkinGate).join(' + '),
      title: `Single-entry pass ${passId} used ${uses.length} times`,
      detail: uses.map(u => `Gate ${u.checkinGate} ${new Date(u.checkinAt).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' })}${u.checkinOffline ? ' (offline)' : ''}`).join(' · '),
      offline: uses.some(u => u.checkinOffline),
      visitIds: uses.map(u => u.visitId)
    });
  }

  for (const v of visitList) {
    if (v.watchlist) {
      v.flags = [...(v.flags || []), 'watchlist'];
      alerts.push({
        id: `wl-${v.visitId}`,
        kind: 'watchlist',
        severity: v.watchlist.level === 'deny' ? 'high' : 'medium',
        at: v.checkinAt,
        gate: v.checkinGate,
        title: `Watchlist person admitted: ${v.name}`,
        detail: watchlistReasons[v.watchlist.ref] || 'On site watchlist',
        offline: v.checkinOffline,
        visitIds: [v.visitId]
      });
    }
    if (v.idCheck === 'mismatch') {
      v.flags = [...(v.flags || []), 'id_mismatch'];
      alerts.push({
        id: `id-${v.visitId}`,
        kind: 'id_mismatch',
        severity: 'medium',
        at: v.checkinAt,
        gate: v.checkinGate,
        title: `ID didn't match pass: ${v.name}`,
        detail: `Admitted by ${v.checkinGuard || 'officer'} after override`,
        offline: v.checkinOffline,
        visitIds: [v.visitId]
      });
    }
    if (v.status === 'on_site' && v.passValidTo && new Date(v.passValidTo) < now) {
      v.flags = [...(v.flags || []), 'overstay'];
      alerts.push({
        id: `over-${v.visitId}`,
        kind: 'overstay',
        severity: 'medium',
        at: v.passValidTo,
        gate: v.checkinGate,
        title: `${v.name} has overstayed`,
        detail: `Pass expired ${new Date(v.passValidTo).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' })}, still signed in`,
        offline: false,
        visitIds: [v.visitId]
      });
    }
  }

  alerts.sort((a, b) => b.at.localeCompare(a.at));
  visitList.sort((a, b) => b.checkinAt.localeCompare(a.checkinAt));

  const today = now.toDateString();
  const onSite = visitList.filter(v => v.status === 'on_site');
  const offlineEvents = events.filter(e => e.recordedOffline);

  return {
    visits: visitList,
    alerts,
    musters: musters.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    invites: Object.values(invites).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    devices: Object.values(devices).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)),
    feed: events.slice(-150).reverse(),
    stats: {
      onSite: onSite.length,
      today: visitList.filter(v => new Date(v.checkinAt).toDateString() === today).length,
      alerts: alerts.length,
      highAlerts: alerts.filter(a => a.severity === 'high').length,
      offlineEvents: offlineEvents.length,
      longestOfflineMs: offlineEvents.reduce((max, e) => Math.max(max, delayMs(e)), 0)
    }
  };
}

module.exports = { buildState };
