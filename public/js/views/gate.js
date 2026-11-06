import { getMeta } from '../db.js';
import { subscribe } from '../sync.js';
import { onSiteVisits, expectedVisitors, findInvite } from '../visits.js';
import { cameraAvailable, startScanner, warnNoCamera } from '../scanner.js';
import { postLabel, typeLabel } from '../config.js';
import { esc, icon, toast, formatTime, timeAgo } from '../ui.js';
import { runCheckin } from './checkin.js';

export default async function gate(root, ctx) {
  const { config } = ctx;
  let inFlow = false;
  let stopCamera = null;
  let lastCache = null;

  const sheetOpen = () => Boolean(root.querySelector('#scan-sheet')?.open);

  async function render() {
    const cache = await getMeta('siteCache');
    lastCache = cache?.fetchedAt || null;
    const [onSite, expected] = await Promise.all([onSiteVisits(), expectedVisitors()]);
    if (inFlow || sheetOpen()) return;

    root.innerHTML = `
      <section class="gate-hero">
        <span class="eyebrow">${esc(config.site.name)}</span>
        <h1>${esc(postLabel(config, ctx.guard))}</h1>
        ${ctx.guard.post?.until ? `<p class="post-until">Temporary post until ${formatTime(ctx.guard.post.until)}</p>` : ''}
        <div class="gate-stats">
          <a href="#onsite"><strong>${onSite.length}</strong><span>on site</span></a>
          <div><strong>${expected.length}</strong><span>expected</span></div>
        </div>
      </section>

      ${cache ? '' : `
        <section class="notice notice-warn">
          ${icon('cloudOff')}
          <p><strong>Not set up for offline use yet.</strong> Connect to the internet once so this device can download the site key and visitor list.</p>
        </section>`}

      <div class="action-grid">
        <button class="action action-primary" data-action="scan">
          ${icon('qr')}<strong>Scan pass</strong><small>QR code on visitor's phone</small>
        </button>
        <div class="action-stack">
          <button class="action action-small" data-action="walkin">
            ${icon('userPlus')}<span><strong>Walk-in</strong><small>No pass</small></span>
          </button>
          <button class="action action-small" data-action="temp">
            ${icon('clock')}<span><strong>Temporary</strong><small>Issue short pass</small></span>
          </button>
        </div>
      </div>

      <h2 class="section-title">Expected visitors</h2>
      ${expected.length ? `
        <ul class="card-list">
          ${expected.map(invite => `
            <li>
              <button class="card-button" data-invite="${esc(invite.id)}">
                <span class="card-icon">${icon(invite.type === 'contractor' ? 'hardhat' : 'user')}</span>
                <span class="card-body">
                  <strong>${esc(invite.name)}</strong>
                  <small>${esc(typeLabel(config, invite.type))}${invite.company ? ` · ${esc(invite.company)}` : ''} · ${esc(invite.host)}</small>
                  <small>${formatTime(invite.validFrom)} – ${formatTime(invite.validTo)} · <span class="mono">${esc(invite.id)}</span></small>
                </span>
                ${icon('chevron')}
              </button>
            </li>`).join('')}
        </ul>` : '<p class="empty">No more visitors expected today.</p>'}

      ${cache ? `<p class="cache-note">Site data downloaded ${timeAgo(cache.fetchedAt)} · ${cache.invites.length} passes · signing key ${esc(cache.keyId)}</p>` : ''}

      <dialog class="sheet" id="scan-sheet">
        <form class="sheet-inner" id="code-form">
          <div class="sheet-head">
            <h2>Scan pass</h2>
            <button type="button" class="icon-btn" data-close aria-label="Close">×</button>
          </div>
          <div class="camera" ${cameraAvailable() ? '' : 'hidden'}>
            <video muted playsinline></video>
            <div class="camera-frame"></div>
            <p class="camera-hint">Hold the visitor's QR code inside the frame</p>
          </div>
          <label class="field">
            <span>Or type the 6-character pass code</span>
            <input name="code" class="id-input" autocomplete="off" autocapitalize="characters" placeholder="e.g. K7Q2XM">
          </label>
          <button class="btn btn-primary btn-block" type="submit">Look up pass</button>
        </form>
      </dialog>
    `;
  }

  async function startFlow(source) {
    inFlow = true;
    try {
      await runCheckin(root, ctx, source);
    } finally {
      inFlow = false;
      render();
    }
  }

  function closeSheet(sheet) {
    stopCamera?.();
    stopCamera = null;
    if (sheet.open) sheet.close();
  }

  async function openScanner() {
    const sheet = root.querySelector('#scan-sheet');
    const form = sheet.querySelector('#code-form');
    form.reset();
    sheet.showModal();
    sheet.onclose = () => closeSheet(sheet);
    sheet.querySelector('[data-close]').onclick = () => closeSheet(sheet);

    form.onsubmit = async event => {
      event.preventDefault();
      const value = form.code.value.trim();
      if (!value) return;
      const invite = value.startsWith('GP1.') ? { token: value } : await findInvite(value);
      if (!invite) {
        toast(`No pass "${value.toUpperCase()}" on this device. Scan the QR instead.`, 'warn');
        return;
      }
      closeSheet(sheet);
      startFlow({ kind: 'pass', token: invite.token, method: 'code' });
    };

    if (cameraAvailable()) {
      try {
        stopCamera = await startScanner(sheet.querySelector('video'), value => {
          closeSheet(sheet);
          navigator.vibrate?.(60);
          startFlow({ kind: 'pass', token: value, method: 'qr' });
        });
      } catch {
        sheet.querySelector('.camera').hidden = true;
        warnNoCamera(toast, 'Camera not available. Type the pass code instead.');
      }
    }
    if (!stopCamera) form.code.focus();
  }

  root.addEventListener('click', async event => {
    if (inFlow) return;
    const invite = event.target.closest('[data-invite]');
    if (invite) {
      const found = await findInvite(invite.dataset.invite);
      if (found) startFlow({ kind: 'pass', token: found.token, method: 'list' });
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'scan') openScanner();
    if (action === 'walkin') startFlow({ kind: 'walkin' });
    if (action === 'temp') startFlow({ kind: 'temp' });
  });

  await render();

  const unsubscribe = subscribe(state => {
    if (!inFlow && !sheetOpen() && state.cacheUpdatedAt && state.cacheUpdatedAt !== lastCache) render();
  });

  return () => {
    unsubscribe();
    stopCamera?.();
  };
}
