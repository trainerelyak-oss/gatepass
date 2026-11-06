import { esc, icon, toast } from '../ui.js';
import { testModeOn, setTestMode } from '../testmode.js';

const KEY = 'gp-tests';

const SECTIONS = [
  {
    title: 'At the gate',
    tests: [
      { id: 'valid', title: 'A real pass is accepted', steps: 'Scan a pass (or TEST → Visitor arrives with a valid pass). Enter the ID shown on the pass.', expect: 'Green screen with the visitor\'s name, then a badge number.', scenario: 'valid' },
      { id: 'forged', title: 'A forged pass is refused', steps: 'TEST → Visitor shows a forged pass (or paste a tampered code from the dashboard).', expect: 'Red "Do not admit: Forged or altered pass". It appears in the control room\'s alerts.', scenario: 'forged' },
      { id: 'twice', title: 'Scanning someone already inside signs them out', steps: 'Scan the same pass again, or type their badge number in the scan box.', expect: '"Sign out <name>?". Sign out, then try Undo.' },
      { id: 'banned', title: 'A banned person is stopped', steps: 'TEST → Banned person tries to walk in (Marcus Wong, 123B).', expect: 'Red "Do not admit". Works offline: the phone only stores fingerprints of the watchlist, never names.', scenario: 'banned' },
      { id: 'escort', title: 'Escort-only person is flagged', steps: 'TEST → Escort-only person walks in (Alicia Teo, 880K).', expect: 'Amber "Escort required", then they can be admitted with a flag.', scenario: 'escort' },
      { id: 'contractor', title: 'Contractor compliance', steps: 'Sign in a contractor (John Lim\'s pass from demo data, ID 567A).', expect: 'Safety rules, permit number and signature are required, then items (issue an access card).' },
      { id: 'items', title: 'Unreturned items are caught', steps: 'Sign the contractor out without ticking the access card.', expect: 'Warning on the phone, and "left without returning items" in the control room.' },
      { id: 'temp', title: 'Temporary pass', steps: 'Gate → Temporary pass for someone without a pass.', expect: 'A QR the visitor can photograph. The control room sees it under Temporary passes for review.' }
    ]
  },
  {
    title: 'Offline',
    tests: [
      { id: 'offline', title: 'Everything keeps working offline', steps: 'TEST → Offline (or turn on airplane mode). Sign someone in, report an incident, then reload the page.', expect: 'Amber Offline badge, records counted as "saved on this device", the app still opens after reload.' },
      { id: 'resync', title: 'It catches up when the connection returns', steps: 'TEST → Online.', expect: 'The waiting count drops to zero and everything appears in the control room, tagged with how long it was offline.' },
      { id: 'reuse', title: 'Same pass at two offline gates', steps: 'Needs 2 devices (or a normal and an incognito window). Take both offline, sign the same single-entry pass in at both, then reconnect both.', expect: 'Control room alert: "Single-entry pass used 2 times".' },
      { id: 'offlinelogin', title: 'Sign in with no connection', steps: 'Sign out, go offline, sign in again with the same account.', expect: 'Works on a device you have signed in on before; a brand-new device needs the internet once.' }
    ]
  },
  {
    title: 'Inside the building',
    tests: [
      { id: 'tailgate', title: 'Tailgating is caught', steps: 'TEST → Spot check: someone who never signed in.', expect: 'Red "Never signed in. Possible tailgating".', scenario: 'tailgater' },
      { id: 'zone', title: 'Wrong zone', steps: 'On site → Spot check → choose Server room → type a visitor\'s badge (e.g. A001).', expect: '"Not allowed in this zone" with the zones they are allowed in.' },
      { id: 'incident', title: 'Incident with witness and evidence', steps: 'Report → Report an incident → add a witness statement (signature) and evidence with a photo.', expect: 'Control room → Incidents shows the photo as VERIFIED. Its follow-up notes come back to the phone.' },
      { id: 'check', title: 'Site check with a shortage', steps: 'Report → Do a site check → Emergency resources, enter 11 extinguishers (expected 12).', expect: 'Shortage alert in the control room.' },
      { id: 'drill', title: 'Fire drill', steps: 'TEST → Fill the site with 5 fake visitors, then TEST → Start a fire drill. Tick some people, finish.', expect: 'List of who is missing, a "Text this list" SMS button, and a roll-call alert in the control room.', scenario: 'drill' },
      { id: 'shift', title: 'End-of-shift report', steps: 'Profile → End-of-shift report → sign.', expect: 'Summary of the shift; appears under Checks & shift reports in the control room.' }
    ]
  },
  {
    title: 'Accounts and permissions',
    tests: [
      { id: 'officer', title: 'Officers can\'t open the control room', steps: 'Sign in to /dashboard with an officer account (officer / officer123 after loading demo data).', expect: '"Needs supervisor access". Officers only use the gate app.' },
      { id: 'supervisor', title: 'Supervisors run the control room but can\'t add IDs', steps: 'Sign in to /dashboard as supervisor / super123.', expect: 'Can issue passes, review temporary passes and follow up incidents. No Admin tab, no Demo tools.' },
      { id: 'admin', title: 'Admins manage people and IDs', steps: 'Sign in as admin → Admin tab: add an officer account, add a watchlist entry.', expect: 'The new officer can sign in on a phone. After the phone syncs, the new watchlist person is refused at the gate.' },
      { id: 'revoke', title: 'Revoking a temporary pass', steps: 'Supervisor → Temporary passes → Revoke. Then spot-check that pass on a phone after it syncs.', expect: '"Pass revoked", and a high alert if the person is still on site.' }
    ]
  }
];

function done() {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function persist(set) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {}
}

export default async function guide(root) {
  const ticked = done();
  const total = SECTIONS.reduce((n, s) => n + s.tests.length, 0);

  function render() {
    root.innerHTML = `
      <a class="back-link" href="#settings">← Shift</a>
      <h1 class="page-title">Demo &amp; test guide</h1>

      <details class="panel why explain">
        <summary>Walk-in or temporary pass?</summary>
        <div class="explain-body">
          <p><strong>Walk-in</strong> is for an ordinary visitor who turns up without a pass and is visiting someone on the normal floors. The officer records who they are and signs them in. It's a one-off visit record, with no QR code.</p>
          <p><strong>Temporary pass</strong> is for when someone needs a pass they can carry: a contractor whose pass is lost, an urgent callout, or a host who can't be reached. The officer's phone signs a short-lived QR pass (up to 4 hours), so other gates and spot checks can verify it offline. Every temporary pass goes to a supervisor for approval or revoking.</p>
        </div>
      </details>

      <details class="panel why explain">
        <summary>How is a forged pass caught?</summary>
        <div class="explain-body">
          <p>Every pass QR holds the visit details plus a <strong>digital signature</strong>, made with a secret key that only the server has (temporary passes are signed by the officer's phone with its own key).</p>
          <p>Each gate phone keeps the matching <strong>public key</strong>. It can check a signature but can't create one. Change a single character, such as stretching the end date, and the signature no longer matches the details, so the phone refuses it, offline.</p>
          <p>A perfect copy of a real pass is caught differently: single-entry passes can't be used twice at the same gate, the ID must match, and if two offline gates both admit it, the control room gets a "used twice" alert when they sync.</p>
          <p>To demo it: dashboard → open a pass → <strong>Copy tampered pass</strong> → paste into the gate's scan box, or TEST → Visitor shows a forged pass.</p>
        </div>
      </details>

      <details class="panel why explain">
        <summary>Who can do what</summary>
        <div class="explain-body">
          <table class="roles-table">
            <thead><tr><th></th><th>Officer</th><th>Supervisor</th><th>Admin</th></tr></thead>
            <tbody>
              <tr><td>Gate app: scan, walk-in, spot check, incidents, roll call</td><td>✓</td><td>✓</td><td>✓</td></tr>
              <tr><td>Issue temporary passes (reviewed later)</td><td>✓</td><td>✓</td><td>✓</td></tr>
              <tr><td>Control room dashboard</td><td>–</td><td>✓</td><td>✓</td></tr>
              <tr><td>Create visitor passes</td><td>–</td><td>✓</td><td>✓</td></tr>
              <tr><td>Approve or revoke temporary passes</td><td>–</td><td>✓</td><td>✓</td></tr>
              <tr><td>Add accounts, change roles, reset passwords</td><td>–</td><td>–</td><td>✓</td></tr>
              <tr><td>Add or remove watchlist IDs</td><td>–</td><td>–</td><td>✓</td></tr>
              <tr><td>Demo tools (reset, fake data)</td><td>–</td><td>–</td><td>✓</td></tr>
            </tbody>
          </table>
        </div>
      </details>

      <section class="panel guide-progress">
        <div>
          <strong>${ticked.size} of ${total} tested</strong>
          <div class="progress"><span style="width:${Math.round((ticked.size / total) * 100)}%"></span></div>
        </div>
        ${testModeOn() ? '' : '<button class="btn btn-secondary btn-sm" data-enable>Turn on test mode</button>'}
      </section>

      ${SECTIONS.map(section => `
        <h2 class="section-title">${esc(section.title)}</h2>
        <ul class="test-list">
          ${section.tests.map(t => `
            <li class="test-item ${ticked.has(t.id) ? 'is-done' : ''}">
              <label class="test-check"><input type="checkbox" data-test="${t.id}" ${ticked.has(t.id) ? 'checked' : ''}></label>
              <div class="test-body">
                <strong>${esc(t.title)}</strong>
                <p><span class="test-label">Do</span>${esc(t.steps)}</p>
                <p><span class="test-label">Expect</span>${esc(t.expect)}</p>
                ${t.scenario ? `<button class="link-button" data-try="${t.scenario}">${icon('scan')} Try it</button>` : ''}
              </div>
            </li>`).join('')}
        </ul>`).join('')}

      <button class="btn btn-ghost btn-block" data-reset>Clear all ticks</button>
    `;
  }

  root.addEventListener('change', event => {
    const box = event.target.closest('[data-test]');
    if (!box) return;
    box.checked ? ticked.add(box.dataset.test) : ticked.delete(box.dataset.test);
    persist(ticked);
    render();
  });

  root.addEventListener('click', async event => {
    if (event.target.closest('[data-enable]')) {
      await setTestMode(true);
      toast('Test mode on', 'ok');
      render();
      return;
    }
    if (event.target.closest('[data-reset]')) {
      ticked.clear();
      persist(ticked);
      render();
      return;
    }
    const tryButton = event.target.closest('[data-try]');
    if (tryButton) {
      if (!testModeOn()) await setTestMode(true);
      document.querySelector(`#testbar [data-scenario="${tryButton.dataset.try}"]`)?.click();
    }
  });

  render();
}
