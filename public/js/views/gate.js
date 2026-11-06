import { getMeta } from '../db.js';
import { subscribe } from '../sync.js';
import { onSiteVisits, expectedVisitors, findInvite, findVisitByBadge } from '../visits.js';
import { cameraAvailable, startScanner, warnNoCamera } from '../scanner.js';
import { postLabel, typeLabel } from '../config.js';
import { esc, icon, toast, formatTime, timeAgo } from '../ui.js';
import { runCheckin } from './checkin.js';
import { takeTestAction } from '../testmode.js';

export default async function gate(root, ctx) {
  const { config } = ctx;
  let inFlow = false;
  let stopCamera = null;
  let lastCache = null;
  let showAll = false;

  const sheetOpen = () => Boolean(root.querySelector('#scan-sheet')?.open);

  async function render() {
    const cache = await getMeta('siteCache');
    lastCache = cache?.fetchedAt || null;
    const [onSite, expected] = await Promise.all([onSiteVisits(), expectedVisitors()]);
    if (inFlow || sheetOpen()) return;

    const shown = showAll ? expected : expected.slice(0, 3);
    root.innerHTML = `
      <header class="gate-head">
        <div>
          <span class="eyebrow">${esc(config.site.name)}</span>
          <h1>${esc(postLabel(config, ctx.guard))}</h1>
          ${ctx.guard.post?.until ? `<p class="post-until">Temporary post until ${formatTime(ctx.guard.post.until)}</p>` : ''}
        </div>
        <a class="onsite-pill" href="#onsite"><strong>${onSite.length}</strong> on site</a>
      </header>

      ${cache ? '' : `
        <section class="notice notice-warn">
          ${icon('cloudOff')}
          <p><strong>Connect once to set up.</strong> This device needs the site key and visitor list before it can work offline.</p>
        </section>`}

      <button class="scan-button" data-action="scan">
        ${icon('qr')}
        <span><strong>Scan pass</strong><small>Sign in or sign out</small></span>
      </button>

      <div class="quick-row">
        <button class="btn btn-secondary" data-action="walkin">${icon('userPlus')} Walk-in</button>
        <button class="btn btn-secondary" data-action="temp">${icon('clock')} Temporary pass</button>
      </div>

      ${expected.length ? `
        <section class="expected">
          <h2 class="section-title">Expected today <span class="muted">${expected.length}</span></h2>
          ${showAll && expected.length > 4 ? `
            <label class="search">
              ${icon('search')}
              <input type="search" data-expected-search placeholder="Find an expected visitor">
            </label>` : ''}
          <ul class="simple-list expected-list">
            ${shown.map(invite => `
              <li data-search="${esc(`${invite.name} ${invite.company || ''} ${invite.host} ${invite.id}`.toLowerCase())}">
                <button class="simple-row" data-invite="${esc(invite.id)}">
                  <span class="simple-main"><strong>${esc(invite.name)}</strong><small>${esc(invite.host)}</small></span>
                  <span class="simple-side">${formatTime(invite.validFrom)}</span>
                </button>
              </li>`).join('')}
          </ul>
          ${expected.length > 3 && !showAll ? `<button class="link-button" data-action="all">Show all ${expected.length}</button>` : ''}
        </section>` : ''}

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
            <span>Or type a pass code or badge number</span>
            <input name="code" class="id-input" autocomplete="off" autocapitalize="characters" placeholder="K7Q2XM or A001">
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
      if (!/^G[PT]1\./.test(value)) {
        const visit = await findVisitByBadge(value);
        if (visit) {
          closeSheet(sheet);
          startFlow({ kind: 'signout', visit });
          return;
        }
      }
      const invite = /^G[PT]1\./.test(value) ? { token: value } : await findInvite(value);
      if (!invite) {
        toast(`No pass or badge "${value.toUpperCase()}" on this device. Scan the QR instead.`, 'warn');
        return;
      }
      closeSheet(sheet);
      startFlow({ kind: 'pass', token: invite.token, method: 'code' });
    };

    form.code.addEventListener('focus', () => {
      stopCamera?.();
      stopCamera = null;
    }, { once: true });

    if (cameraAvailable()) {
      let handled = false;
      try {
        const stop = await startScanner(sheet.querySelector('video'), value => {
          if (handled) return;
          handled = true;
          closeSheet(sheet);
          startFlow({ kind: 'pass', token: value, method: 'qr' });
        });
        if (handled || !sheet.open) stop();
        else stopCamera = stop;
      } catch {
        if (!handled && sheet.open) {
          sheet.querySelector('.camera').hidden = true;
          warnNoCamera(toast, 'Camera not available. Type the pass code instead.');
        }
      }
    }
    if (!stopCamera) form.code.focus();
  }

  root.addEventListener('input', event => {
    if (!event.target.matches('[data-expected-search]')) return;
    const q = event.target.value.trim().toLowerCase();
    root.querySelectorAll('.expected-list li').forEach(li => { li.hidden = q && !li.dataset.search.includes(q); });
  });

  const onKey = event => {
    if (inFlow || sheetOpen() || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target.closest('input, textarea, select')) return;
    const key = event.key.toLowerCase();
    if (key === 's') openScanner();
    else if (key === 'w') startFlow({ kind: 'walkin' });
    else if (key === 't') startFlow({ kind: 'temp' });
    else return;
    event.preventDefault();
  };
  document.addEventListener('keydown', onKey);

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
    if (action === 'all') {
      showAll = true;
      render();
    }
    if (action === 'walkin') startFlow({ kind: 'walkin' });
    if (action === 'temp') startFlow({ kind: 'temp' });
  });

  await render();

  const test = takeTestAction('gate');
  if (test?.action === 'pass') startFlow({ kind: 'pass', token: test.token, method: 'test' });
  if (test?.action === 'walkin') startFlow({ kind: 'walkin', prefill: test.prefill });

  const unsubscribe = subscribe(state => {
    if (!inFlow && !sheetOpen() && state.cacheUpdatedAt && state.cacheUpdatedAt !== lastCache) render();
  });

  return () => {
    unsubscribe();
    document.removeEventListener('keydown', onKey);
    stopCamera?.();
  };
}
