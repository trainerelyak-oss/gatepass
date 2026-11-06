import { getMeta, setMeta, clearRecords, countPending } from '../db.js';
import { subscribe, setSimulatedOffline, syncNow } from '../sync.js';
import { esc, icon, timeAgo, toast } from '../ui.js';

export default async function settings(root, ctx) {
  const deviceId = await getMeta('deviceId');

  root.innerHTML = `
    <h1 class="page-title">Shift & device</h1>

    <section class="panel profile">
      <span class="profile-avatar">${icon('user')}</span>
      <div>
        <strong>${esc(ctx.guard.name)}</strong>
        <small>${esc(ctx.guard.id)} · on shift since ${new Date(ctx.guard.signedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
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
      <button class="btn btn-secondary btn-block" data-action="sync">${icon('sync')} Upload now</button>
    </section>

    <section class="panel">
      <label class="switch-row">
        <span>
          <strong>Test mode: force offline</strong>
          <small>Acts as if there's no signal, without turning off Wi-Fi. Handy for demos.</small>
        </span>
        <input type="checkbox" class="switch" data-action="simulate">
      </label>
    </section>

    <section class="stack">
      <button class="btn btn-ghost btn-block" data-action="signout">End shift / switch officer</button>
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

  root.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'sync') {
      await syncNow();
    } else if (action === 'signout') {
      const pending = await countPending();
      const message = pending
        ? `${pending} record${pending > 1 ? 's are' : ' is'} still waiting to upload. They'll stay on this device and upload later. End shift?`
        : 'End your shift on this device?';
      if (!confirm(message)) return;
      await setMeta('guard', null);
      await setMeta('activeRound', null);
      ctx.guard = null;
      ctx.navigate('patrol');
    } else if (action === 'wipe') {
      const pending = await countPending();
      if (pending && !confirm(`${pending} record${pending > 1 ? 's have' : ' has'} NOT been uploaded and will be lost. Erase anyway?`)) return;
      if (!pending && !confirm('Erase all records stored on this device?')) return;
      await clearRecords();
      await setMeta('activeRound', null);
      await syncNow();
      toast('Device records erased', 'ok');
    }
  });

  return unsubscribe;
}
