import { getMeta, setMeta } from './db.js';
import { getState, setSimulatedOffline, subscribe } from './sync.js';
import { expectedVisitors, onSiteVisits } from './visits.js';
import { saveRecord, uid } from './records.js';
import { icon, toast } from './ui.js';

const FIRST = ['Aaron', 'Bee Lian', 'Chandra', 'Elaine', 'Faisal', 'Grace', 'Hafiz', 'Irene', 'Jun Wei', 'Kavitha', 'Leon', 'Mei Xin', 'Nabil', 'Priyanka', 'Rashid', 'Shu Fen'];
const LAST = ['Tan', 'Lim', 'Ng', 'Wong', 'Rahman', 'Kumar', 'Lee', 'Goh', 'Chua', 'Ismail', 'Singh', 'Ong'];
const HOSTS = ['Acme Pte Ltd, #12-03', 'HR, #08-01', 'Facilities, L1', 'Lumen Labs, #05-11'];

let enabled = false;
let ctxRef = null;

const pick = list => list[Math.floor(Math.random() * list.length)];

export function fakePerson() {
  const digits = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const letter = String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return { name: `${pick(FIRST)} ${pick(LAST)}`, partialId: `${digits}${letter}`, host: pick(HOSTS) };
}

export function testModeOn() {
  return enabled;
}

function tamper(token) {
  const [head, body, signature] = token.split('.');
  let s = body.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const payload = JSON.parse(atob(s));
  payload.e += 7 * 24 * 60 * 60;
  const forged = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${head}.${forged}.${signature}`;
}

async function unusedInvite(filter = () => true) {
  const list = (await expectedVisitors()).filter(i => new Date(i.validFrom) <= Date.now() + 30 * 60000).filter(filter);
  return list.length ? pick(list) : null;
}

function run(action, payload) {
  sessionStorage.setItem('testAction', JSON.stringify({ action, ...payload }));
  if (location.hash === `#${payload.route}`) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = payload.route;
}

const SCENARIOS = [
  {
    id: 'valid',
    label: 'Visitor arrives with a valid pass',
    async go() {
      const invite = await unusedInvite();
      if (!invite) return toast('No expected visitors on this device. Load demo data on the dashboard, then sync.', 'warn');
      run('pass', { route: 'gate', token: invite.token });
    }
  },
  {
    id: 'forged',
    label: 'Visitor shows a forged pass',
    async go() {
      const cache = await getMeta('siteCache');
      const invite = cache?.invites?.[0];
      if (!invite) return toast('No passes on this device yet. Load demo data and sync first.', 'warn');
      run('pass', { route: 'gate', token: tamper(invite.token) });
    }
  },
  {
    id: 'walkin',
    label: 'Walk-in visitor (random details)',
    go: () => run('walkin', { route: 'gate', prefill: fakePerson() })
  },
  {
    id: 'banned',
    label: 'Banned person tries to walk in',
    go: () => run('walkin', { route: 'gate', prefill: { name: 'Marcus Wong', partialId: '123B', host: 'Lobby cafe' } })
  },
  {
    id: 'escort',
    label: 'Escort-only person walks in',
    go: () => run('walkin', { route: 'gate', prefill: { name: 'Alicia Teo', partialId: '880K', host: 'HR, #08-01' } })
  },
  {
    id: 'tailgater',
    label: 'Spot check: someone who never signed in',
    async go() {
      const invite = await unusedInvite();
      if (!invite) return toast('No unused passes on this device. Load demo data first.', 'warn');
      run('spot', { route: 'spot', token: invite.token, zone: 'server' });
    }
  },
  {
    id: 'fill',
    label: 'Fill the site with 5 fake visitors',
    async go() {
      for (let i = 0; i < 5; i++) {
        const person = fakePerson();
        const gate = ctxRef.guard.gate;
        await saveRecord('checkin', {
          visitId: uid(),
          badge: `${gate}${String(800 + Math.floor(Math.random() * 99)).padStart(3, '0')}`,
          gate,
          name: person.name,
          partialId: person.partialId,
          visitorType: pick(['visitor', 'visitor', 'contractor', 'delivery']),
          host: person.host,
          company: null,
          method: 'walkin',
          zones: ['common', 'office'],
          escort: false,
          items: [],
          idCheck: 'recorded',
          watchlist: null,
          induction: null,
          photos: []
        });
      }
      toast('5 fake visitors signed in', 'ok');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  },
  {
    id: 'drill',
    label: 'Start a fire drill (roll call)',
    async go() {
      if (!(await onSiteVisits()).length) return toast('Nobody is on site yet. Add fake visitors first.', 'warn');
      run('muster', { route: 'muster' });
    }
  }
];

function renderBar() {
  let bar = document.getElementById('testbar');
  if (!enabled || !ctxRef?.guard) {
    bar?.remove();
    document.body.classList.remove('testing');
    return;
  }
  document.body.classList.add('testing');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'testbar';
    bar.className = 'testbar';
    bar.innerHTML = `
      <button class="testbar-toggle" type="button" aria-expanded="false">${icon('scan')} TEST</button>
      <div class="testbar-panel" hidden>
        <div class="testbar-head">
          <strong>Test mode</strong>
          <button type="button" class="link-button" data-close>Close</button>
        </div>
        <div class="segmented two" role="radiogroup">
          <button type="button" class="seg" data-net="online">Online</button>
          <button type="button" class="seg" data-net="offline">Offline</button>
        </div>
        <div class="testbar-actions">
          ${SCENARIOS.map(s => `<button type="button" class="testbar-action" data-scenario="${s.id}">${s.label}</button>`).join('')}
        </div>
        <a class="link-button" href="#guide">Open the test checklist</a>
        <p class="muted small">Records made while test mode is on are tagged TEST in the control room.</p>
      </div>`;
    document.body.append(bar);
    const panel = bar.querySelector('.testbar-panel');
    const toggle = bar.querySelector('.testbar-toggle');
    const setOpen = open => {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => setOpen(panel.hidden));
    bar.querySelector('[data-close]').addEventListener('click', () => setOpen(false));
    bar.addEventListener('click', async event => {
      const net = event.target.closest('[data-net]');
      if (net) {
        await setSimulatedOffline(net.dataset.net === 'offline');
        return;
      }
      const scenario = event.target.closest('[data-scenario]');
      if (scenario) {
        setOpen(false);
        await SCENARIOS.find(s => s.id === scenario.dataset.scenario).go();
      }
      if (event.target.closest('a[href="#guide"]')) setOpen(false);
    });
  }
  const offline = getState().simulatedOffline;
  bar.querySelectorAll('[data-net]').forEach(b => b.setAttribute('aria-checked', String((b.dataset.net === 'offline') === offline)));
  bar.querySelector('.testbar-toggle').classList.toggle('is-offline', offline);
}

export async function initTestMode(ctx) {
  ctxRef = ctx;
  enabled = Boolean(await getMeta('testMode'));
  subscribe(renderBar);
  renderBar();
}

export async function setTestMode(on) {
  enabled = on;
  await setMeta('testMode', on);
  if (!on && getState().simulatedOffline) await setSimulatedOffline(false);
  renderBar();
}

export function refreshTestBar() {
  renderBar();
}

export function takeTestAction(route) {
  const raw = sessionStorage.getItem('testAction');
  if (!raw) return null;
  const action = JSON.parse(raw);
  if (action.route !== route) return null;
  sessionStorage.removeItem('testAction');
  return action;
}
