const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { loadSigningKey, passCode, issuePass, watchlistHash } = require('./passes');
const { buildState } = require('./visits');
const { openStore } = require('./store');
const { ROLES, hashPassword, verifyPassword, createTokens, hasRole, publicUser, normaliseUsername } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_BODY = 40 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const ROUTES = {
  '/': 'index.html',
  '/dashboard': 'dashboard.html',
  '/pass': 'pass.html'
};

fs.mkdirSync(DATA_DIR, { recursive: true });

const site = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'data', 'site.json'), 'utf8'));
let store;
let db;
let signingKey;
let watchlist;
let tokens;

async function loadDb() {
  const data = await store.load();
  if (!data.epoch) store.setMeta('epoch', (data.epoch = crypto.randomUUID()));
  if (!data.salt) store.setMeta('salt', (data.salt = crypto.randomBytes(16).toString('hex')));
  return data;
}

function save(collection, id) {
  store.put(collection, id, db[collection][id]);
}

const loginFailures = new Map();

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function currentUser(req) {
  const payload = tokens.read(bearer(req));
  const user = payload && db.users[payload.uid];
  if (!user || !user.active || (user.tokenVersion || 0) !== payload.ver) return null;
  return user;
}

function requireRole(req, res, role) {
  const user = currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Please sign in', code: 'auth' });
    return null;
  }
  if (!hasRole(user, role)) {
    sendJson(res, 403, { error: `Needs ${ROLES[role].label.toLowerCase()} access`, code: 'forbidden' });
    return null;
  }
  return user;
}

function activeAdmins() {
  return Object.values(db.users).filter(u => u.active && u.role === 'admin');
}

function createUser({ name, username, password, role }, by) {
  const uname = normaliseUsername(username);
  if (uname.length < 3) throw inviteError('Username needs at least 3 letters or numbers');
  if (Object.values(db.users).some(u => u.username === uname)) throw inviteError('That username is already taken');
  if (String(password || '').length < 6) throw inviteError('Password needs at least 6 characters');
  if (!ROLES[role]) throw inviteError('Pick a role: officer, supervisor or admin');
  const id = crypto.randomUUID();
  db.users[id] = {
    id,
    username: uname,
    name: String(name || uname).trim().slice(0, 60) || uname,
    role,
    active: true,
    passwordHash: hashPassword(password),
    tokenVersion: 0,
    createdAt: new Date().toISOString(),
    createdBy: by || null
  };
  save('users', id);
  return db.users[id];
}

function session(user) {
  return { token: tokens.issue(user), user: publicUser(user) };
}

async function handleAuth(pathname, req, res) {
  if (pathname === '/api/auth/status') {
    return sendJson(res, 200, { needsSetup: Object.keys(db.users).length === 0, site: site.site.name });
  }
  if (pathname === '/api/auth/me') {
    const user = requireRole(req, res, 'officer');
    return user && sendJson(res, 200, { user: publicUser(user) });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  const body = await readJson(req, res);
  if (!body) return;

  if (pathname === '/api/auth/setup') {
    if (Object.keys(db.users).length) return sendJson(res, 403, { error: 'Setup is already done. Sign in instead.' });
    try {
      const user = createUser({ ...body, role: 'admin' }, 'setup');
      return sendJson(res, 201, session(user));
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    }
  }

  if (pathname === '/api/auth/login') {
    const username = normaliseUsername(body.username);
    const recent = (loginFailures.get(username) || []).filter(t => Date.now() - t < 5 * 60000);
    if (recent.length >= 5) return sendJson(res, 429, { error: 'Too many attempts. Wait 5 minutes and try again.' });
    const user = Object.values(db.users).find(u => u.username === username);
    if (!user || !user.active || !verifyPassword(body.password, user.passwordHash)) {
      loginFailures.set(username, [...recent, Date.now()]);
      return sendJson(res, 401, { error: 'Wrong username or password' });
    }
    loginFailures.delete(username);
    user.lastLoginAt = new Date().toISOString();
    save('users', user.id);
    return sendJson(res, 200, session(user));
  }
  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

async function handleUsers(pathname, req, res, admin) {
  if (pathname === '/api/users' && req.method === 'GET') {
    return sendJson(res, 200, { users: Object.values(db.users).map(publicUser).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  const body = req.method === 'GET' ? {} : await readJson(req, res);
  if (!body) return;
  try {
    if (pathname === '/api/users' && req.method === 'POST') {
      return sendJson(res, 201, { user: publicUser(createUser(body, admin.username)) });
    }
    const match = pathname.match(/^\/api\/users\/([\w-]+)$/);
    const user = match && db.users[match[1]];
    if (!user || req.method !== 'PATCH') return sendJson(res, 404, { error: 'User not found' });
    const losingAdmin = user.role === 'admin' && user.active && ((body.role && body.role !== 'admin') || body.active === false);
    if (losingAdmin && activeAdmins().length <= 1) throw inviteError('Keep at least one active admin');
    if (body.name) user.name = String(body.name).trim().slice(0, 60);
    if (body.role) {
      if (!ROLES[body.role]) throw inviteError('Unknown role');
      if (body.role !== user.role) user.tokenVersion = (user.tokenVersion || 0) + 1;
      user.role = body.role;
    }
    if (typeof body.active === 'boolean') {
      if (!body.active) user.tokenVersion = (user.tokenVersion || 0) + 1;
      user.active = body.active;
    }
    if (body.password) {
      if (String(body.password).length < 6) throw inviteError('Password needs at least 6 characters');
      user.passwordHash = hashPassword(body.password);
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }
    save('users', user.id);
    return sendJson(res, 200, { user: publicUser(user) });
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message });
  }
}

async function handleWatchlist(pathname, req, res, admin) {
  if (req.method === 'GET') {
    return sendJson(res, 200, { entries: Object.values(db.watchlist).sort((a, b) => a.name.localeCompare(b.name)) });
  }
  if (req.method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return;
    const name = String(body.name || '').trim().slice(0, 60);
    const partialId = String(body.partialId || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (!name) return sendJson(res, 400, { error: 'Name is required' });
    if (!/^\d{3}[A-Z]$/.test(partialId)) return sendJson(res, 400, { error: 'ID must be the last 3 digits and letter, e.g. 123B' });
    const id = crypto.randomUUID();
    db.watchlist[id] = { id, name, partialId, level: body.level === 'alert' ? 'alert' : 'deny', reason: String(body.reason || '').slice(0, 200), addedBy: admin.username, addedAt: new Date().toISOString() };
    save('watchlist', id);
    watchlist = loadWatchlist();
    return sendJson(res, 201, { entry: db.watchlist[id] });
  }
  const match = pathname.match(/^\/api\/watchlist\/([\w-]+)$/);
  if (req.method === 'DELETE' && match && db.watchlist[match[1]]) {
    delete db.watchlist[match[1]];
    store.remove('watchlist', match[1]);
    watchlist = loadWatchlist();
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

function seedWatchlist() {
  if (db.watchlistSeeded) return;
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.json'), 'utf8'));
  } catch {}
  store.transaction(() => {
    for (const entry of entries) {
      const id = crypto.randomUUID();
      db.watchlist[id] = { id, name: entry.name, partialId: entry.partialId, level: entry.level, reason: entry.reason || '', addedBy: 'setup', addedAt: new Date().toISOString() };
      save('watchlist', id);
    }
    store.setMeta('watchlistSeeded', (db.watchlistSeeded = true));
  });
}

function loadWatchlist() {
  const entries = Object.values(db.watchlist || {});
  const hashed = entries.map(entry => ({
    h: watchlistHash(db.salt, entry.name, entry.partialId),
    level: entry.level === 'deny' ? 'deny' : 'alert',
    reason: entry.reason || ''
  }));
  return {
    public: { salt: db.salt, entries: hashed.map(({ h, level }) => ({ h, level })) },
    reasons: Object.fromEntries(hashed.map(e => [e.h.slice(0, 12), e.reason]))
  };
}

function touchDevice(info, at) {
  if (!info || !info.deviceId) return;
  const existing = db.devices[info.deviceId] || {};
  db.devices[info.deviceId] = {
    deviceId: info.deviceId,
    gate: info.gate || existing.gate || null,
    postName: info.postName || existing.postName || null,
    temporaryUntil: info.temporaryUntil || null,
    guardName: info.guardName || existing.guardName || null,
    pending: Number.isFinite(info.pending) ? info.pending : existing.pending ?? null,
    lastSeenAt: at,
    lastUploadAt: existing.lastUploadAt || null
  };
  save('devices', info.deviceId);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const err = new Error('Payload too large');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function storePhotos(record) {
  if (!Array.isArray(record.photos)) return { photos: [], integrity: [] };
  const photos = [];
  const integrity = [];
  for (const [index, photo] of record.photos.entries()) {
    const match = typeof photo === 'string' && photo.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
    if (!match) {
      if (typeof photo === 'string' && photo.startsWith('/photos/')) photos.push(photo);
      continue;
    }
    const bytes = Buffer.from(match[2], 'base64');
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const name = `${record.id.replace(/[^a-zA-Z0-9-]/g, '')}-${index}.${ext}`;
    await store.putBlob(name, bytes, `image/${match[1]}`);
    photos.push(`/photos/${name}`);
    const expected = record.photoHashes?.[index];
    if (expected) {
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      integrity.push(actual === expected ? 'verified' : 'mismatch');
    }
  }
  return { photos, integrity };
}

async function handleSync(req, res, user) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status ? err.message : 'Invalid JSON' });
  }

  const incoming = Array.isArray(body.records) ? body.records : [];
  const receivedAt = new Date().toISOString();
  touchDevice(body.device, receivedAt);
  if (body.device?.deviceId && incoming.length) {
    db.devices[body.device.deviceId].lastUploadAt = receivedAt;
    save('devices', body.device.deviceId);
  }
  const accepted = [];
  const changed = [];

  for (const record of incoming) {
    if (!record || typeof record.id !== 'string' || typeof record.type !== 'string') continue;
    const existing = db.records[record.id];
    const revision = Number(record.revision) || 1;
    if (existing && existing.revision >= revision) {
      accepted.push(record.id);
      continue;
    }
    const { syncStatus, syncedAt, ...clean } = record;
    const { photos, integrity } = await storePhotos(record);
    db.records[record.id] = {
      ...clean,
      revision,
      photos,
      ...(integrity.length ? { photoIntegrity: integrity } : {}),
      deviceId: record.deviceId || body.device?.deviceId || null,
      syncedBy: user.username,
      receivedAt: existing ? existing.receivedAt : receivedAt,
      updatedAt: receivedAt
    };
    accepted.push(record.id);
    changed.push(record.id);
  }

  store.transaction(() => changed.forEach(id => save('records', id)));
  sendJson(res, 200, { accepted, serverTime: receivedAt });
}

function currentState() {
  return buildState(db, watchlist.reasons);
}

function handleBootstrap(url, res, user) {
  const now = new Date();
  touchDevice({
    deviceId: url.searchParams.get('deviceId'),
    gate: url.searchParams.get('gate'),
    postName: url.searchParams.get('post'),
    temporaryUntil: url.searchParams.get('until'),
    guardName: url.searchParams.get('guard'),
    pending: url.searchParams.has('pending') ? Number(url.searchParams.get('pending')) : undefined
  }, now.toISOString());
  const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const state = currentState();
  sendJson(res, 200, {
    serverTime: now.toISOString(),
    epoch: db.epoch,
    me: publicUser(user),
    keyId: signingKey.keyId,
    publicKey: signingKey.publicJwk,
    watchlist: watchlist.public,
    invites: state.invites
      .filter(i => i.validTo > now.toISOString())
      .map(({ id, name, type, company, host, validFrom, validTo, multiEntry, zones, escort, token }) => ({ id, name, type, company, host, validFrom, validTo, multiEntry, zones, escort, token })),
    visits: state.visits
      .filter(v => v.status === 'on_site' || v.checkinAt > dayAgo)
      .map(({ visitId, badge, name, visitorType, company, host, passId, passValidTo, multiEntry, zones, escort, items, permitNo, tempPass, checkinAt, checkinGate, status, checkoutAt, checkoutGate }) => ({ visitId, badge, name, visitorType, company, host, passId, passValidTo, multiEntry, zones, escort, items, permitNo, tempPass: tempPass && { id: tempPass.id, validTo: tempPass.validTo, reason: tempPass.reason, review: tempPass.review }, checkinAt, checkinGate, status, checkoutAt, checkoutGate })),
    deviceKeys: Object.values(db.deviceKeys).map(({ keyId, deviceId, jwk, gate, postName }) => ({ keyId, deviceId, jwk, gate, postName })),
    revoked: Object.entries(db.reviews).filter(([, r]) => r.decision === 'revoked').map(([id]) => id),
    incidents: state.incidents
      .filter(i => i.currentStatus !== 'closed' || i.updatedAt > threeDaysAgo)
      .map(i => ({
        incidentId: i.incidentId,
        title: i.title,
        category: i.category,
        severity: i.severity,
        location: i.location,
        gate: i.gate,
        guardName: i.guardName,
        createdAt: i.createdAt,
        currentStatus: i.currentStatus,
        witnessCount: i.witnesses.length,
        evidenceCount: i.evidence.length,
        notes: i.notes.map(n => ({ id: n.id, text: n.text, status: n.status || null, author: n.guardName, source: n.source || 'device', createdAt: n.createdAt }))
      }))
  });
}

function inviteError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

async function handleCreateInvite(req, res, user) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  try {
    const invite = createInvite({ ...body, createdBy: user.username });
    sendJson(res, 201, invite);
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message });
  }
}

function createInvite(body) {
  const name = String(body.name || '').trim().slice(0, 60);
  const host = String(body.host || '').trim().slice(0, 60);
  const type = site.visitorTypes.some(t => t.id === body.type) ? body.type : 'visitor';
  const validFrom = new Date(body.validFrom || Date.now());
  const validTo = new Date(body.validTo || Date.now() + 8 * 60 * 60 * 1000);
  const partialId = String(body.partialId || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const zoneIds = new Set(site.zones.map(z => z.id));
  const zones = (Array.isArray(body.zones) ? body.zones : site.defaultZones[type] || []).filter(z => zoneIds.has(z));

  if (!name || !host) throw inviteError('Visitor name and host are required');
  if (isNaN(validFrom) || isNaN(validTo) || validTo <= validFrom) throw inviteError('Invalid visit window');
  if (partialId && !/^\d{3}[A-Z]$/.test(partialId)) throw inviteError('Partial ID must be the last 3 digits and letter, e.g. 567A');

  let id = passCode();
  while (db.invites[id]) id = passCode();

  const invite = {
    id,
    name,
    host,
    type,
    company: String(body.company || '').trim().slice(0, 60) || null,
    partialId: partialId || null,
    validFrom: validFrom.toISOString(),
    validTo: validTo.toISOString(),
    multiEntry: Boolean(body.multiEntry),
    zones,
    escort: Boolean(body.escort),
    createdBy: body.createdBy || null,
    createdAt: new Date().toISOString()
  };
  invite.token = issuePass(signingKey, invite, site.site.id);
  db.invites[id] = invite;
  save('invites', id);
  return invite;
}

async function handleDemoReset(res) {
  db.records = {};
  db.invites = {};
  db.reviews = {};
  db.devices = {};
  db.epoch = crypto.randomUUID();
  store.transaction(() => {
    for (const name of ['records', 'invites', 'reviews', 'devices']) store.clear(name);
    store.setMeta('epoch', db.epoch);
  });
  await store.clearBlobs();
  sendJson(res, 200, { ok: true, epoch: db.epoch });
}

function seedCheckin(fields, minutesAgo) {
  const at = new Date(Date.now() - minutesAgo * 60000).toISOString();
  const id = crypto.randomUUID();
  db.records[id] = {
    id,
    type: 'checkin',
    revision: 1,
    visitId: crypto.randomUUID(),
    createdAt: at,
    receivedAt: at,
    updatedAt: at,
    deviceId: 'seed',
    recordedOffline: false,
    location: null,
    photos: [],
    idCheck: 'recorded',
    watchlist: null,
    induction: null,
    multiEntry: false,
    passId: null,
    passValidTo: null,
    tempPass: null,
    ...fields
  };
  save('records', id);
}

const DEMO_ACCOUNTS = [
  { username: 'officer', name: 'Daniel Tan', role: 'officer', password: 'officer123' },
  { username: 'officer2', name: 'Siti Rahman', role: 'officer', password: 'officer123' },
  { username: 'supervisor', name: 'Kumar S.', role: 'supervisor', password: 'super123' }
];

const FAKE_FIRST = ['Aaron', 'Bee Lian', 'Chandra', 'Daniel', 'Elaine', 'Faisal', 'Grace', 'Hafiz', 'Irene', 'Jun Wei', 'Kavitha', 'Leon', 'Mei Xin', 'Nabil', 'Oliver', 'Priyanka', 'Qi Hui', 'Rashid', 'Shu Fen', 'Terence'];
const FAKE_LAST = ['Tan', 'Lim', 'Ng', 'Wong', 'Rahman', 'Kumar', 'Lee', 'Goh', 'Chua', 'Ismail', 'Singh', 'Ong'];
const FAKE_HOSTS = ['Acme Pte Ltd, #12-03', 'HR, #08-01', 'Facilities, L1', 'Lumen Labs, #05-11', 'Building management'];

async function handleFakeVisitors(req, res) {
  const body = await readJson(req, res);
  if (!body) return;
  const count = Math.min(Math.max(Number(body.count) || 5, 1), 50);
  const pick = list => list[crypto.randomInt(list.length)];
  store.transaction(() => {
    for (let i = 0; i < count; i++) {
      const type = pick(['visitor', 'visitor', 'contractor', 'delivery']);
      const gate = pick(['A', 'B', 'C']);
      seedCheckin({
        test: true,
        badge: `${gate}${String(900 + crypto.randomInt(99)).padStart(3, '0')}`,
        gate,
        guardName: 'Test data',
        guardId: 'TEST',
        name: `${pick(FAKE_FIRST)} ${pick(FAKE_LAST)}`,
        partialId: `${String(crypto.randomInt(1000)).padStart(3, '0')}${String.fromCharCode(65 + crypto.randomInt(26))}`,
        visitorType: type,
        host: pick(FAKE_HOSTS),
        company: type === 'visitor' ? null : pick(['Kinetic M&E', 'Swift Logistics', 'ABC Engineering']),
        method: 'walkin',
        zones: site.defaultZones[type] || ['common'],
        escort: false,
        items: type === 'contractor' ? [{ kind: 'issued', name: 'Access card', ref: `AC-${300 + crypto.randomInt(99)}` }] : [],
        permitNo: type === 'contractor' ? `PTW-TEST-${100 + crypto.randomInt(899)}` : null
      }, crypto.randomInt(5, 240));
    }
  });
  sendJson(res, 200, { ok: true, added: count });
}

async function handleDemoSeed(res, admin) {
  const accounts = [];
  for (const account of DEMO_ACCOUNTS) {
    if (!Object.values(db.users).some(u => u.username === account.username)) {
      createUser(account, admin.username);
      accounts.push(account);
    }
  }
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const priya = createInvite({ name: 'Priya Nair', type: 'visitor', host: 'Acme Pte Ltd, #12-03', partialId: '101D', validFrom: new Date(now - 0.5 * hour).toISOString(), validTo: new Date(now + 6 * hour).toISOString() });
  const john = createInvite({ name: 'John Lim', type: 'contractor', company: 'ABC Engineering', host: 'Building management', partialId: '567A', zones: ['common', 'loading', 'plant'], validFrom: new Date(now - 0.5 * hour).toISOString(), validTo: new Date(now + 8 * hour).toISOString() });
  createInvite({ name: 'Wei Jie Tan', type: 'interview', host: 'Acme Pte Ltd, #12-03', validFrom: new Date(now + 1 * hour).toISOString(), validTo: new Date(now + 3 * hour).toISOString() });
  store.transaction(() => {
  seedCheckin({ badge: 'C001', gate: 'C', guardName: 'Ahmad Razak', guardId: 'SO-2210', name: 'Mei Ling Goh', partialId: '238H', visitorType: 'visitor', host: 'Acme Pte Ltd, #12-03', company: null, method: 'walkin', zones: ['common', 'office'], escort: false, items: [{ kind: 'issued', name: 'Visitor lanyard', ref: '' }], permitNo: null }, 45);
  seedCheckin({ badge: 'B001', gate: 'B', guardName: 'Siti Rahman', guardId: 'SO-1877', name: 'Ahmad Bin Ismail', partialId: '774J', visitorType: 'contractor', host: 'M&E works, L4 plant room', company: 'Kinetic M&E', method: 'walkin', zones: ['common', 'loading', 'plant'], escort: false, items: [{ kind: 'issued', name: 'Access card', ref: 'AC-208' }, { kind: 'declared', name: 'Power tools', ref: 'Drill + grinder' }], permitNo: 'PTW-2026-0398', induction: { items: site.induction, acknowledgedAt: new Date(now - 80 * 60000).toISOString(), signature: null, permitNo: 'PTW-2026-0398' } }, 80);
  });
  sendJson(res, 200, { ok: true, passes: { priya: priya.id, john: john.id }, accounts: accounts.map(({ username, password, role }) => ({ username, password, role })) });
}

async function readJson(req, res) {
  try {
    return JSON.parse((await readBody(req)) || '{}');
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return null;
  }
}

async function handleDeviceKey(req, res) {
  const body = await readJson(req, res);
  if (!body) return;
  const jwk = body.jwk;
  if (!body.deviceId || !body.keyId || !jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    return sendJson(res, 400, { error: 'Invalid device key' });
  }
  const keyId = String(body.keyId).slice(0, 32);
  db.deviceKeys[keyId] = {
    keyId,
    deviceId: String(body.deviceId).slice(0, 64),
    jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    gate: body.gate || null,
    postName: body.postName || null,
    registeredAt: new Date().toISOString()
  };
  save('deviceKeys', keyId);
  sendJson(res, 201, { ok: true });
}

async function handleReview(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  if (!body.passId || !['approved', 'revoked'].includes(body.decision)) {
    return sendJson(res, 400, { error: 'passId and decision (approved | revoked) required' });
  }
  db.reviews[body.passId] = {
    decision: body.decision,
    note: String(body.note || '').slice(0, 300) || null,
    by: user.name,
    byUser: user.username,
    at: new Date().toISOString()
  };
  save('reviews', body.passId);
  sendJson(res, 200, db.reviews[body.passId]);
}

async function handleIncidentNote(req, res, incidentId, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const text = String(body.text || '').trim().slice(0, 2000);
  const status = ['open', 'investigating', 'escalated', 'closed'].includes(body.status) ? body.status : null;
  if (!text && !status) return sendJson(res, 400, { error: 'Add a note or change the status' });
  const incident = Object.values(db.records).find(r => r.type === 'incident' && r.incidentId === incidentId);
  if (!incident) return sendJson(res, 404, { error: 'Incident not found' });
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.records[id] = {
    id,
    type: 'incident_note',
    incidentId,
    text,
    status,
    source: 'control',
    guardName: user.name,
    gate: null,
    createdAt: now,
    receivedAt: now,
    updatedAt: now,
    revision: 1,
    recordedOffline: false,
    photos: []
  };
  save('records', id);
  sendJson(res, 201, db.records[id]);
}

function handleRecords(url, res) {
  const since = url.searchParams.get('since');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 500, 2000);
  let records = Object.values(db.records);
  if (since) records = records.filter(r => r.updatedAt > since);
  records.sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));
  sendJson(res, 200, { records: records.slice(0, limit), total: Object.keys(db.records).length, serverTime: new Date().toISOString() });
}

async function serveFile(res, baseDir, relative, cacheControl = 'no-cache') {
  const filePath = path.normalize(path.join(baseDir, relative));
  if (!filePath.startsWith(baseDir + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('Not a file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cacheControl
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, serverTime: new Date().toISOString() });
    }
    if (pathname.startsWith('/api/auth/')) {
      return await handleAuth(pathname, req, res);
    }
    if (pathname === '/api/sync' && req.method === 'POST') {
      const user = requireRole(req, res, 'officer');
      return user && await handleSync(req, res, user);
    }
    if (pathname === '/api/bootstrap' && req.method === 'GET') {
      const user = requireRole(req, res, 'officer');
      return user && handleBootstrap(url, res, user);
    }
    if (pathname === '/api/devices/key' && req.method === 'POST') {
      const user = requireRole(req, res, 'officer');
      return user && await handleDeviceKey(req, res);
    }
    if (pathname === '/api/records' && req.method === 'GET') {
      const user = requireRole(req, res, 'supervisor');
      return user && handleRecords(url, res);
    }
    if (pathname === '/api/state' && req.method === 'GET') {
      const user = requireRole(req, res, 'supervisor');
      return user && sendJson(res, 200, { ...currentState(), serverTime: new Date().toISOString(), me: publicUser(user) });
    }
    if (pathname === '/api/invites' && req.method === 'POST') {
      const user = requireRole(req, res, 'supervisor');
      return user && await handleCreateInvite(req, res, user);
    }
    if (pathname === '/api/reviews' && req.method === 'POST') {
      const user = requireRole(req, res, 'supervisor');
      return user && await handleReview(req, res, user);
    }
    const noteMatch = pathname.match(/^\/api\/incidents\/([\w-]+)\/notes$/);
    if (noteMatch && req.method === 'POST') {
      const user = requireRole(req, res, 'supervisor');
      return user && await handleIncidentNote(req, res, noteMatch[1], user);
    }
    if (pathname === '/api/users' || pathname.startsWith('/api/users/')) {
      const user = requireRole(req, res, 'admin');
      return user && await handleUsers(pathname, req, res, user);
    }
    if (pathname === '/api/watchlist' || pathname.startsWith('/api/watchlist/')) {
      const user = requireRole(req, res, 'admin');
      return user && await handleWatchlist(pathname, req, res, user);
    }
    if (pathname.startsWith('/api/demo/') && req.method === 'POST') {
      const user = requireRole(req, res, 'admin');
      if (!user) return;
      if (pathname === '/api/demo/reset') return await handleDemoReset(res);
      if (pathname === '/api/demo/seed') return await handleDemoSeed(res, user);
      if (pathname === '/api/demo/fake-visitors') return await handleFakeVisitors(req, res);
    }
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Unknown endpoint' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    if (pathname.startsWith('/photos/')) {
      const name = path.basename(decodeURIComponent(pathname.slice('/photos/'.length)));
      const bytes = await store.getBlob(name);
      if (!bytes) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
        'Content-Length': bytes.length,
        'Cache-Control': 'private, max-age=86400'
      });
      return res.end(bytes);
    }
    const relative = ROUTES[pathname] || decodeURIComponent(pathname);
    return await serveFile(res, PUBLIC_DIR, relative);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
  }
});

async function main() {
  store = await openStore(DATA_DIR);
  db = await loadDb();
  for (const name of ['users', 'watchlist']) db[name] = db[name] || {};
  if (!db.authSecret) store.setMeta('authSecret', (db.authSecret = crypto.randomBytes(32).toString('base64')));
  tokens = createTokens(db.authSecret);
  if (!Object.keys(db.users).length && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    createUser({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD, name: 'Administrator', role: 'admin' }, 'env');
    console.log(`  Created admin account "${normaliseUsername(process.env.ADMIN_USERNAME)}" from environment`);
  }
  seedWatchlist();
  signingKey = loadSigningKey(DATA_DIR, db.signingKey, jwks => store.setMeta('signingKey', (db.signingKey = jwks)));
  watchlist = loadWatchlist();
  server.listen(PORT, onListening);
}

function onListening() {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => `http://${i.address}:${PORT}`);
  const relative = path.relative(process.cwd(), store.location);
  console.log(`GatePass running · ${store.kind} database: ${store.kind === 'Supabase' ? store.location : relative.startsWith('..') ? store.location : relative}`);
  console.log(`  Gate app:      http://localhost:${PORT}`);
  console.log(`  Control room:  http://localhost:${PORT}/dashboard`);
  for (const addr of addresses) console.log(`  On network: ${addr}`);
}

main().catch(err => {
  console.error(`\nGatePass could not start: ${err.message}\n`);
  process.exit(1);
});
