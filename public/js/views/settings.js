import { getMeta, setMeta, clearRecords, countPending } from '../db.js';
import { subscribe, setSimulatedOffline, syncNow } from '../sync.js';
import { esc, icon, timeAgo, toast } from '../ui.js';
import { postLabel } from '../config.js';
import { currentTheme, setTheme } from '../theme.js';
import { soundEnabled, setSound, feedback } from '../feedback.js';

export default async function settings(root, ctx) {
  const deviceId = await getMeta('deviceId');
  const cache = await getMeta('siteCache');

  root.innerHTML = `
    <h1 class="page-title">Shift</h1>

    <section class="panel profile">
      <span class="profile-avatar">${icon('user')}</span>
      <div>
        <strong>${esc(ctx.guard.name)}</strong>
        <small>${esc(ctx.guard.id)} · on shift since ${new Date(ctx.guard.signedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
        <small>${esc(postLabel(ctx.config, ctx.guard))}</small>
      </div>
    </section>

    <section class="panel">
      <h2 class="panel-title">Connection</h2>
      <dl class="facts">
        <div><dt>Status</dt><dd data-fact="status">—</dd></div>
        <div><dt>Waiting to upload</dt><dd data-fact="pending">—</dd></div>
        <div><dt>Last upload</dt><dd data-fact="last">—</dd></div>
        <div><dt>Device</dt><dd class="mono">${esc(deviceId?.slice(0, 8))}</dd></div>
      </dl>
      <label class="switch-row">
          <span>
            <strong>Test mode: force offline</strong>
            <small>Act as if there's no signal (for demos)</small>
          </span>
          <input type="checkbox" class="switch" data-action="simulate">
        </label>
      <button class="btn btn-secondary btn-block" data-action="sync">${icon('sync')} Sync now</button>
    </section>

    <details class="panel why">
      <summary>Offline readiness</summary>
      <dl class="facts">
        <div><dt>Site data</dt><dd>${cache ? timeAgo(cache.fetchedAt) : 'Not downloaded'}</dd></div>
        <div><dt>Signing key</dt><dd class="mono">${esc(cache?.keyId || '—')}</dd></div>
        <div><dt>Passes stored</dt><dd>${cache?.invites.length ?? 0}</dd></div>
        <div><dt>Watchlist entries</dt><dd>${cache?.watchlist.entries.length ?? 0} <small class="muted">(fingerprints only)</small></dd></div>
      </dl>
    </details>

    <section class="panel stack">
      <h2 class="panel-title">Display & sound</h2>
      <div class="segmented two">
        <button type="button" class="seg" data-theme-pick="dark" aria-checked="${currentTheme() === 'dark'}">Dark</button>
        <button type="button" class="seg" data-theme-pick="light" aria-checked="${currentTheme() === 'light'}">Light (bright sun)</button>
      </div>
      <label class="switch-row">
        <span>
          <strong>Sounds</strong>
          <small>Beep on valid, refused and warning results. Phones also vibrate.</small>
        </span>
        <input type="checkbox" class="switch" data-action="sound" ${soundEnabled() ? 'checked' : ''}>
      </label>
      ${window.installPrompt ? `<button class="btn btn-secondary btn-block" data-action="install">${icon('logIn')} Install GatePass on this device</button>` : ''}
    </section>



    <section class="stack">
      <a class="btn btn-primary btn-block" href="#shift">${icon('clipboard')} End-of-shift report</a>
      <a class="btn btn-secondary btn-block" href="#log">${icon('list')} Gate log</a>
      <button class="btn btn-ghost btn-block" data-action="signout">End shift / change post</button>
      <button class="btn btn-ghost btn-block danger-text" data-action="wipe">Erase records on this device</button>
    </section>
  `;

  const toggle = root.querySelector('[data-action="simulate"]');

  const unsubscribe = subscribe(state => {
    toggle.checked = state.simulatedOffline;
    root.querySelector('[data-fact="status"]').textContent = state.simulatedOffline
      ? 'Offline (test mode)'
      : !state.online ? 'No network'
      : state.syncing ? 'Uploading…'
      : state.reachable ? 'Connected' : 'Server unreachable';
    root.querySelector('[data-fact="pending"]').textContent = state.pending;
    root.querySelector('[data-fact="last"]').textContent = timeAgo(state.lastSync);
  });

  toggle.addEventListener('change', () => setSimulatedOffline(toggle.checked));

  root.querySelector('[data-action="sound"]').addEventListener('change', event => {
    setSound(event.target.checked);
    if (event.target.checked) feedback('good');
  });

  root.addEventListener('click', async event => {
    const theme = event.target.closest('[data-theme-pick]');
    if (theme) {
      setTheme(theme.dataset.themePick);
      root.querySelectorAll('[data-theme-pick]').forEach(b => b.setAttribute('aria-checked', String(b === theme)));
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'install' && window.installPrompt) {
      window.installPrompt.prompt();
      window.installPrompt = null;
      event.target.closest('[data-action]').remove();
      return;
    }
    if (action === 'sync') {
      await syncNow();
    } else if (action === 'signout') {
      const pending = await countPending();
      const message = pending
        ? `${pending} record${pending > 1 ? 's are' : ' is'} still waiting to upload. They'll stay on this device and upload later. End shift?`
        : 'End your shift on this device?';
      if (!confirm(message)) return;
      await setMeta('guard', null);
      ctx.guard = null;
      ctx.navigate('gate');
    } else if (action === 'wipe') {
      const pending = await countPending();
      if (pending && !confirm(`${pending} record${pending > 1 ? 's have' : ' has'} NOT been uploaded and will be lost. Erase anyway?`)) return;
      if (!pending && !confirm('Erase all records stored on this device?')) return;
      await clearRecords();
      await setMeta('activeMuster', null);
      await syncNow();
      toast('Device records erased', 'ok');
    }
  });

  return unsubscribe;
}
