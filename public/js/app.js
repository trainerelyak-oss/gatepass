import { getMeta, setMeta } from './db.js';
import { init as initSync, subscribe, syncNow } from './sync.js';
import { loadConfig } from './config.js';
import { uid, startLocationWatch } from './records.js';
import { icon, timeAgo, toast } from './ui.js';
import { onSiteVisits } from './visits.js';
import gateView from './views/gate.js';
import onsiteView from './views/onsite.js';
import musterView from './views/muster.js';
import spotView from './views/spotcheck.js';
import incidentsView from './views/incidents.js';
import checksView from './views/checks.js';
import reportView from './views/report.js';
import shiftView from './views/shift.js';
import logView from './views/log.js';
import settingsView from './views/settings.js';
import onboardingView from './views/onboarding.js';

const routes = {
  gate: gateView,
  onsite: onsiteView,
  muster: musterView,
  spot: spotView,
  incidents: incidentsView,
  checks: checksView,
  report: reportView,
  shift: shiftView,
  log: logView,
  settings: settingsView
};

const ctx = {
  config: null,
  guard: null,
  navigate
};

let teardown = null;
let routeToken = 0;

function navigate(name) {
  if (location.hash === `#${name}`) route();
  else location.hash = name;
}

async function route() {
  const token = ++routeToken;
  if (teardown) {
    teardown();
    teardown = null;
  }

  const previous = document.getElementById('view');
  const main = previous.cloneNode(false);
  previous.replaceWith(main);
  window.scrollTo(0, 0);

  if (!ctx.guard) {
    document.body.classList.add('signed-out');
    const cleanup = await onboardingView(main, ctx);
    if (token === routeToken) teardown = cleanup || null;
    return;
  }

  document.body.classList.remove('signed-out');
  const name = routes[location.hash.slice(1)] ? location.hash.slice(1) : 'gate';
  const tab = { spot: 'onsite', shift: 'settings', log: 'settings', incidents: 'report', checks: 'report' }[name] || name;
  document.querySelectorAll('.tabbar a').forEach(a => {
    a.classList.toggle('active', a.dataset.route === tab);
  });

  const cleanup = await routes[name](main, ctx);
  if (token === routeToken) teardown = cleanup || null;
  else if (cleanup) cleanup();
}

function renderStatus(state) {
  const pill = document.getElementById('status');
  const label = pill.querySelector('.label');
  let tone = 'online';
  let text = 'Online';

  if (state.simulatedOffline) {
    tone = 'offline';
    text = 'Offline (test)';
  } else if (!state.online) {
    tone = 'offline';
    text = 'Offline';
  } else if (state.syncing) {
    tone = 'syncing';
    text = 'Syncing';
  } else if (!state.reachable) {
    tone = 'offline';
    text = 'No server';
  }

  pill.dataset.tone = tone;
  label.textContent = text;

  const strip = document.getElementById('sync-strip');
  const stripText = strip.querySelector('.sync-strip-text');
  const stripIcon = strip.querySelector('.sync-strip-icon');
  const action = strip.querySelector('.sync-strip-action');
  const offline = tone === 'offline';
  const count = `${state.pending} record${state.pending === 1 ? '' : 's'}`;

  if (offline) {
    strip.hidden = false;
    strip.dataset.tone = 'offline';
    stripIcon.innerHTML = icon('cloudOff');
    stripText.textContent = state.pending
      ? `No connection. ${count} saved on this device, will sync automatically.`
      : 'No connection. Keep working, everything is saved on this device.';
    action.hidden = true;
  } else if (state.pending) {
    strip.hidden = false;
    strip.dataset.tone = state.syncing ? 'syncing' : 'pending';
    stripIcon.innerHTML = icon('sync');
    stripText.textContent = state.syncing ? `Uploading ${count}…` : `${count} waiting to upload${state.lastError ? ` (${state.lastError})` : ''}`;
    action.hidden = state.syncing;
  } else {
    strip.hidden = true;
  }

  const badge = document.querySelector('[data-badge="log"]');
  badge.hidden = !state.pending;
  badge.textContent = state.pending > 99 ? '99+' : state.pending;
  updateOnSiteBadge();

  pill.title = state.lastSync ? `Last synced ${timeAgo(state.lastSync)}` : 'Not synced yet';
}

let onSiteTimer = null;

function updateOnSiteBadge() {
  clearTimeout(onSiteTimer);
  onSiteTimer = setTimeout(async () => {
    const count = (await onSiteVisits()).length;
    const badge = document.querySelector('[data-badge="onsite"]');
    badge.hidden = !count;
    badge.textContent = count > 99 ? '99+' : count;
  }, 150);
}

let wakeLock = null;

async function updateWakeLock() {
  const wanted = ctx.guard && ['gate', 'muster', 'spot'].includes(location.hash.slice(1) || 'gate') && document.visibilityState === 'visible';
  try {
    if (wanted && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!wanted && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

let lastReset = null;

async function boot() {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    window.installPrompt = event;
  });
  document.addEventListener('visibilitychange', updateWakeLock);

  document.querySelectorAll('[data-icon]').forEach(el => {
    el.innerHTML = icon(el.dataset.icon);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  if (!(await getMeta('deviceId'))) await setMeta('deviceId', uid());
  ctx.config = await loadConfig();
  ctx.guard = (await getMeta('guard')) || null;

  subscribe(renderStatus);
  document.getElementById('status').addEventListener('click', () => syncNow());
  document.querySelector('.sync-strip-action').addEventListener('click', () => syncNow());
  window.addEventListener('hashchange', () => {
    route();
    updateOnSiteBadge();
    updateWakeLock();
  });
  subscribe(state => {
    if (state.siteReset && state.siteReset !== lastReset) {
      if (lastReset !== null || state.siteReset) toast('Site data was reset by the control room', 'warn');
      lastReset = state.siteReset;
      route();
    }
  });

  route();
  initSync();
  startLocationWatch();
  updateWakeLock();
}

boot();
