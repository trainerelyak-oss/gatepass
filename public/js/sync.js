import { pendingRecords, countPending, markSynced, getMeta, setMeta } from './db.js';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
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
  lastError: null
};

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
  if (record.type === 'incident') return SEVERITY_RANK[record.severity] ?? 2;
  if (record.type === 'inspection') return record.failedCount > 0 ? 2 : 4;
  if (record.type === 'patrol') return 4;
  return 5;
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

async function run() {
  await refreshPending();
  const reachable = await checkServer();
  if (!reachable || state.pending === 0) {
    emit();
    return;
  }

  state.syncing = true;
  state.lastError = null;
  emit();

  try {
    const deviceId = await getMeta('deviceId');
    const queue = (await pendingRecords()).sort(
      (a, b) => priority(a) - priority(b) || a.createdAt.localeCompare(b.createdAt)
    );

    for (const batch of batches(queue)) {
      if (!isConnected()) break;
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, records: batch.map(payload) })
      });
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      const { accepted, serverTime } = await res.json();
      const sent = batch
        .filter(r => accepted.includes(r.id))
        .map(r => ({ id: r.id, revision: r.revision }));
      await markSynced(sent, serverTime);
      await refreshPending();
      emit();
    }

    state.lastSync = new Date().toISOString();
    await setMeta('lastSync', state.lastSync);
  } catch (err) {
    state.lastError = err.message || 'Sync failed';
    state.reachable = false;
  } finally {
    state.syncing = false;
    await refreshPending();
    emit();
  }
}

export function syncNow() {
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
