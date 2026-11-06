import { pendingRecords, countPending, markSynced, getMeta, setMeta, clearRecords } from './db.js';
import { registerDeviceKey } from './devicekey.js';
import { authHeaders } from './session.js';

const MAX_BATCH_BYTES = 3 * 1024 * 1024;
const MAX_BATCH_RECORDS = 20;
const POLL_INTERVAL = 15000;

const state = {
  online: navigator.onLine,
  reachable: false,
  simulatedOffline: false,
  syncing: false,
  pending: 0,
  lastSync: null,
  lastError: null,
  authError: false,
  cacheUpdatedAt: null
};

function checkAuth(res) {
  if (res.status === 401) {
    state.authError = true;
    const err = new Error('Signed out on the server');
    err.auth = true;
    throw err;
  }
}

const listeners = new Set();
let inFlight = null;
let started = false;

export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(state);
}

export function getState() {
  return state;
}

export function isConnected() {
  return state.online && state.reachable && !state.simulatedOffline;
}

function priority(record) {
  if (record.type === 'denied' || record.watchlist) return 0;
  if (record.type === 'incident' && (record.severity === 'critical' || record.severity === 'high')) return 0;
  if (record.type === 'spotcheck' && record.result !== 'ok') return 0;
  if (record.type === 'muster') return 1;
  if (record.type === 'checkin' || record.type === 'checkout' || record.type === 'incident') return 2;
  return 3;
}

function payload(record) {
  const { syncStatus, syncedAt, ...rest } = record;
  return rest;
}

function batches(records) {
  const groups = [];
  let current = [];
  let size = 0;
  for (const record of records) {
    const bytes = JSON.stringify(payload(record)).length;
    if (current.length && (size + bytes > MAX_BATCH_BYTES || current.length >= MAX_BATCH_RECORDS)) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(record);
    size += bytes;
  }
  if (current.length) groups.push(current);
  return groups;
}

async function checkServer() {
  if (state.simulatedOffline || !navigator.onLine) {
    state.reachable = false;
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: controller.signal });
    state.reachable = res.ok;
  } catch {
    state.reachable = false;
  } finally {
    clearTimeout(timer);
  }
  return state.reachable;
}

async function refreshPending() {
  state.pending = await countPending();
}

async function deviceInfo() {
  const guard = await getMeta('guard');
  return {
    deviceId: await getMeta('deviceId'),
    gate: guard?.gate || null,
    postName: guard?.post?.name || null,
    temporaryUntil: guard?.post?.until || null,
    guardName: guard?.name || null
  };
}

async function pullSiteCache() {
  const device = await deviceInfo();
  try {
    await registerDeviceKey(device, authHeaders());
  } catch {}
  const params = new URLSearchParams({
    deviceId: device.deviceId || '',
    gate: device.gate || '',
    guard: device.guardName || '',
    post: device.postName || '',
    until: device.temporaryUntil || '',
    pending: String(state.pending)
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const res = await fetch(`/api/bootstrap?${params}`, { cache: 'no-store', signal: controller.signal, headers: authHeaders() }).finally(() => clearTimeout(timer));
  checkAuth(res);
  if (!res.ok) throw new Error(`Server responded with ${res.status}`);
  const data = await res.json();
  const previous = await getMeta('siteCache');
  if (previous?.epoch && data.epoch && previous.epoch !== data.epoch) {
    await clearRecords();
    await setMeta('activeMuster', null);
    await setMeta('badgeCounter', null);
    state.siteReset = data.epoch;
  }
  data.fetchedAt = new Date().toISOString();
  await setMeta('siteCache', data);
  state.cacheUpdatedAt = data.fetchedAt;
}

async function run() {
  await refreshPending();
  const reachable = await checkServer();
  if (!authHeaders().Authorization) {
    emit();
    return;
  }
  if (state.authError) {
    emit();
    return;
  }
  if (!reachable) {
    emit();
    return;
  }
  if (state.pending === 0) {
    try {
      await pullSiteCache();
      state.lastSync = new Date().toISOString();
      await setMeta('lastSync', state.lastSync);
    } catch (err) {
      state.lastError = err.message || 'Sync failed';
    }
    emit();
    return;
  }

  state.syncing = true;
  state.lastError = null;
  emit();

  try {
    const device = await deviceInfo();
    const queue = (await pendingRecords()).sort(
      (a, b) => priority(a) - priority(b) || a.createdAt.localeCompare(b.createdAt)
    );

    for (const batch of batches(queue)) {
      if (!isConnected()) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const res = await fetch('/api/sync', {
        signal: controller.signal,
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ device, records: batch.map(payload) })
      });
      clearTimeout(timer);
      checkAuth(res);
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      const { accepted, serverTime } = await res.json();
      const sent = batch
        .filter(r => accepted.includes(r.id))
        .map(r => ({ id: r.id, revision: r.revision }));
      await markSynced(sent, serverTime);
      await refreshPending();
      emit();
    }

    await pullSiteCache();
    state.lastSync = new Date().toISOString();
    await setMeta('lastSync', state.lastSync);
  } catch (err) {
    state.lastError = err.message || 'Sync failed';
    if (!err.auth) state.reachable = false;
  } finally {
    state.syncing = false;
    await refreshPending();
    emit();
  }
}

export function syncNow(resetAuth = false) {
  if (resetAuth) state.authError = false;
  if (!inFlight) inFlight = run().finally(() => { inFlight = null; });
  return inFlight;
}

export async function setSimulatedOffline(value) {
  state.simulatedOffline = value;
  if (value) state.reachable = false;
  await setMeta('simulatedOffline', value);
  emit();
  if (!value) syncNow();
}

export async function notifyChange() {
  await refreshPending();
  emit();
  syncNow();
}

export async function init() {
  if (started) return;
  started = true;
  state.simulatedOffline = Boolean(await getMeta('simulatedOffline'));
  state.lastSync = (await getMeta('lastSync')) || null;
  state.cacheUpdatedAt = (await getMeta('siteCache'))?.fetchedAt || null;
  await refreshPending();

  window.addEventListener('online', () => {
    state.online = true;
    syncNow();
  });
  window.addEventListener('offline', () => {
    state.online = false;
    state.reachable = false;
    emit();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  setInterval(syncNow, POLL_INTERVAL);

  emit();
  syncNow();
}
