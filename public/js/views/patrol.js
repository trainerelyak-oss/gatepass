import { getMeta, setMeta, recordsByType } from '../db.js';
import { saveRecord, uid } from '../records.js';
import { cameraScanSupported, parseCheckpointCode, startCameraScan } from '../scanner.js';
import { esc, icon, toast, formatTime, timeAgo, formatDuration } from '../ui.js';

export default async function patrol(root, ctx) {
  const { checkpoints } = ctx.config;
  let round = await getMeta('activeRound');
  let lastScans = {};
  let stopCamera = null;
  let clock = null;

  async function loadLastScans() {
    lastScans = {};
    for (const scan of await recordsByType('scan')) {
      if (!lastScans[scan.checkpointId]) lastScans[scan.checkpointId] = scan.createdAt;
    }
  }

  function checkpointRows() {
    return checkpoints
      .map(cp => {
        const visitedAt = round?.visited[cp.id];
        const last = lastScans[cp.id];
        const status = round
          ? visitedAt ? `Checked ${formatTime(visitedAt)}` : 'Pending'
          : last ? `Last checked ${timeAgo(last)}` : 'Not checked yet';
        return `
          <li class="checkpoint ${visitedAt ? 'is-done' : ''}">
            <span class="checkpoint-state">${visitedAt ? icon('check') : `<span class="checkpoint-code">${esc(cp.id.replace('CP-', ''))}</span>`}</span>
            <span class="checkpoint-body">
              <strong>${esc(cp.name)}</strong>
              <small>${esc(cp.zone)} · ${esc(status)}</small>
            </span>
          </li>`;
      })
      .join('');
  }

  function render() {
    if (!round) {
      root.innerHTML = `
        <section class="panel hero">
          <span class="eyebrow">${esc(ctx.config.site.name)}</span>
          <h1>No patrol in progress</h1>
          <p class="muted">Start a round and check in at each checkpoint as you reach it. Works with no signal.</p>
          <button class="btn btn-primary btn-block" data-action="start">${icon('route')} Start patrol round</button>
        </section>
        <h2 class="section-title">Checkpoints</h2>
        <ul class="checkpoint-list">${checkpointRows()}</ul>
      `;
      return;
    }

    const done = Object.keys(round.visited).length;
    const total = checkpoints.length;
    const pct = total ? Math.round((done / total) * 100) : 0;

    root.innerHTML = `
      <section class="panel round">
        <div class="round-head">
          <div>
            <span class="eyebrow">Round in progress</span>
            <h1>${done} of ${total} checkpoints</h1>
            <p class="muted round-clock">${icon('clock')} Started ${formatTime(round.startedAt)} · <span data-elapsed>${formatDuration(Date.now() - new Date(round.startedAt))}</span></p>
          </div>
        </div>
        <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
        <button class="btn btn-primary btn-block btn-large" data-action="scan">${icon('scan')} Check in at checkpoint</button>
      </section>
      <ul class="checkpoint-list">${checkpointRows()}</ul>
      <button class="btn btn-ghost btn-block" data-action="end">${done === total ? 'Finish round' : 'End round early'}</button>

      <dialog class="sheet" id="scan-sheet">
        <form method="dialog" class="sheet-inner" id="code-form">
          <div class="sheet-head">
            <h2>Check in</h2>
            <button type="button" class="icon-btn" data-action="close" aria-label="Close">×</button>
          </div>
          <div class="camera" ${cameraScanSupported() ? '' : 'hidden'}>
            <video muted playsinline></video>
            <div class="camera-frame"></div>
            <p class="camera-hint">Point at the checkpoint QR tag</p>
          </div>
          <p class="muted small" ${cameraScanSupported() ? 'hidden' : ''}>Camera scanning isn't available in this browser. Enter the code printed on the tag instead.</p>
          <label class="field">
            <span>Checkpoint code</span>
            <input name="code" placeholder="e.g. CP-03" autocapitalize="characters" autocomplete="off">
          </label>
          <button class="btn btn-primary btn-block" type="submit" value="manual">Check in</button>
        </form>
      </dialog>
    `;
  }

  async function checkIn(raw, method) {
    const id = parseCheckpointCode(raw);
    const cp = checkpoints.find(c => c.id === id);
    if (!cp) {
      toast(`"${raw}" isn't a checkpoint at this site`, 'error');
      return false;
    }
    if (round.visited[cp.id]) {
      toast(`${cp.name} is already checked this round`, 'warn');
      return true;
    }
    const record = await saveRecord('scan', {
      roundId: round.id,
      checkpointId: cp.id,
      checkpointName: cp.name,
      zone: cp.zone,
      method
    });
    round.visited[cp.id] = record.createdAt;
    await setMeta('activeRound', round);
    navigator.vibrate?.(60);
    toast(`Checked in: ${cp.name}`, 'ok');
    return true;
  }

  async function openSheet() {
    const sheet = root.querySelector('#scan-sheet');
    const form = sheet.querySelector('#code-form');
    const video = sheet.querySelector('video');
    form.reset();
    sheet.showModal();

    const close = () => {
      stopCamera?.();
      stopCamera = null;
      if (sheet.open) sheet.close();
      render();
    };

    sheet.onclose = () => {
      stopCamera?.();
      stopCamera = null;
    };
    sheet.querySelector('[data-action="close"]').onclick = close;
    form.onsubmit = async event => {
      event.preventDefault();
      const code = form.code.value.trim();
      if (!code) return;
      if (await checkIn(code, 'manual')) close();
    };

    if (cameraScanSupported()) {
      try {
        stopCamera = await startCameraScan(video, async value => {
          if (await checkIn(value, 'qr')) close();
        });
      } catch {
        sheet.querySelector('.camera').hidden = true;
        toast('Camera unavailable, enter the code instead', 'warn');
      }
    }
    if (!stopCamera) form.code.focus();
  }

  async function endRound() {
    const visited = checkpoints.filter(cp => round.visited[cp.id]);
    const missed = checkpoints.filter(cp => !round.visited[cp.id]);
    if (missed.length && !confirm(`${missed.length} checkpoint${missed.length > 1 ? 's' : ''} not checked. End the round anyway?`)) return;
    await saveRecord('patrol', {
      roundId: round.id,
      startedAt: round.startedAt,
      endedAt: new Date().toISOString(),
      total: checkpoints.length,
      visited: visited.map(cp => ({ id: cp.id, name: cp.name, at: round.visited[cp.id] })),
      missed: missed.map(cp => ({ id: cp.id, name: cp.name }))
    });
    round = null;
    await setMeta('activeRound', null);
    await loadLastScans();
    toast(missed.length ? 'Round ended with missed checkpoints' : 'Round complete', missed.length ? 'warn' : 'ok');
    render();
  }

  root.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'start') {
      round = { id: uid(), startedAt: new Date().toISOString(), visited: {} };
      await setMeta('activeRound', round);
      render();
    } else if (action === 'scan') {
      openSheet();
    } else if (action === 'end') {
      endRound();
    }
  });

  await loadLastScans();
  render();

  clock = setInterval(() => {
    const el = root.querySelector('[data-elapsed]');
    if (el && round) el.textContent = formatDuration(Date.now() - new Date(round.startedAt));
  }, 15000);

  return () => {
    clearInterval(clock);
    stopCamera?.();
  };
}
