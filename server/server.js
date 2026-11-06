const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { loadSigningKey, passCode, issuePass, watchlistHash } = require('./passes');
const { buildState } = require('./visits');
const { openStore } = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
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

fs.mkdirSync(PHOTO_DIR, { recursive: true });

const site = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'data', 'site.json'), 'utf8'));
const signingKey = loadSigningKey(DATA_DIR);
const store = openStore(DATA_DIR);
const db = loadDb();
const watchlist = loadWatchlist();

function loadDb() {
  const data = store.load();
  if (!data.epoch) store.setMeta('epoch', (data.epoch = crypto.randomUUID()));
  if (!data.salt) store.setMeta('salt', (data.salt = crypto.randomBytes(16).toString('hex')));
  return data;
}

function save(collection, id) {
  store.put(collection, id, db[collection][id]);
}

function loadWatchlist() {
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.json'), 'utf8'));
  } catch {}
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
    await fsp.writeFile(path.join(PHOTO_DIR, name), bytes);
    photos.push(`/photos/${name}`);
    const expected = record.photoHashes?.[index];
    if (expected) {
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      integrity.push(actual === expected ? 'verified' : 'mismatch');
    }
  }
  return { photos, integrity };
}

async function handleSync(req, res) {
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

function handleBootstrap(url, res) {
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

async function handleCreateInvite(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  try {
    const invite = createInvite(body);
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
  for (const file of await fsp.readdir(PHOTO_DIR).catch(() => [])) {
    await fsp.unlink(path.join(PHOTO_DIR, file)).catch(() => {});
  }
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

async function handleDemoSeed(res) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const priya = createInvite({ name: 'Priya Nair', type: 'visitor', host: 'Acme Pte Ltd, #12-03', partialId: '101D', validFrom: new Date(now - 0.5 * hour).toISOString(), validTo: new Date(now + 6 * hour).toISOString() });
  const john = createInvite({ name: 'John Lim', type: 'contractor', company: 'ABC Engineering', host: 'Building management', partialId: '567A', zones: ['common', 'loading', 'plant'], validFrom: new Date(now - 0.5 * hour).toISOString(), validTo: new Date(now + 8 * hour).toISOString() });
  createInvite({ name: 'Wei Jie Tan', type: 'interview', host: 'Acme Pte Ltd, #12-03', validFrom: new Date(now + 1 * hour).toISOString(), validTo: new Date(now + 3 * hour).toISOString() });
  store.transaction(() => {
  seedCheckin({ badge: 'C001', gate: 'C', guardName: 'Ahmad Razak', guardId: 'SO-2210', name: 'Mei Ling Goh', partialId: '238H', visitorType: 'visitor', host: 'Acme Pte Ltd, #12-03', company: null, method: 'walkin', zones: ['common', 'office'], escort: false, items: [{ kind: 'issued', name: 'Visitor lanyard', ref: '' }], permitNo: null }, 45);
  seedCheckin({ badge: 'B001', gate: 'B', guardName: 'Siti Rahman', guardId: 'SO-1877', name: 'Ahmad Bin Ismail', partialId: '774J', visitorType: 'contractor', host: 'M&E works, L4 plant room', company: 'Kinetic M&E', method: 'walkin', zones: ['common', 'loading', 'plant'], escort: false, items: [{ kind: 'issued', name: 'Access card', ref: 'AC-208' }, { kind: 'declared', name: 'Power tools', ref: 'Drill + grinder' }], permitNo: 'PTW-2026-0398', induction: { items: site.induction, acknowledgedAt: new Date(now - 80 * 60000).toISOString(), signature: null, permitNo: 'PTW-2026-0398' } }, 80);
  });
  sendJson(res, 200, { ok: true, passes: { priya: priya.id, john: john.id } });
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

async function handleReview(req, res) {
  const body = await readJson(req, res);
  if (!body) return;
  if (!body.passId || !['approved', 'revoked'].includes(body.decision)) {
    return sendJson(res, 400, { error: 'passId and decision (approved | revoked) required' });
  }
  db.reviews[body.passId] = {
    decision: body.decision,
    note: String(body.note || '').slice(0, 300) || null,
    by: String(body.by || 'Control room').slice(0, 60),
    at: new Date().toISOString()
  };
  save('reviews', body.passId);
  sendJson(res, 200, db.reviews[body.passId]);
}

async function handleIncidentNote(req, res, incidentId) {
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
    guardName: String(body.by || 'Control room').slice(0, 60),
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
    if (pathname === '/api/sync' && req.method === 'POST') {
      return await handleSync(req, res);
    }
    if (pathname === '/api/records' && req.method === 'GET') {
      return handleRecords(url, res);
    }
    if (pathname === '/api/bootstrap' && req.method === 'GET') {
      return handleBootstrap(url, res);
    }
    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, { ...currentState(), serverTime: new Date().toISOString() });
    }
    if (pathname === '/api/invites' && req.method === 'POST') {
      return await handleCreateInvite(req, res);
    }
    if (pathname === '/api/demo/reset' && req.method === 'POST') {
      return await handleDemoReset(res);
    }
    if (pathname === '/api/demo/seed' && req.method === 'POST') {
      return await handleDemoSeed(res);
    }
    if (pathname === '/api/devices/key' && req.method === 'POST') {
      return await handleDeviceKey(req, res);
    }
    if (pathname === '/api/reviews' && req.method === 'POST') {
      return await handleReview(req, res);
    }
    const noteMatch = pathname.match(/^\/api\/incidents\/([\w-]+)\/notes$/);
    if (noteMatch && req.method === 'POST') {
      return await handleIncidentNote(req, res, noteMatch[1]);
    }
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Unknown endpoint' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    if (pathname.startsWith('/photos/')) {
      return await serveFile(res, PHOTO_DIR, decodeURIComponent(pathname.slice('/photos/'.length)), 'public, max-age=86400');
    }
    const relative = ROUTES[pathname] || decodeURIComponent(pathname);
    return await serveFile(res, PUBLIC_DIR, relative);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => `http://${i.address}:${PORT}`);
  const relative = path.relative(process.cwd(), store.file);
  console.log(`GatePass running · ${store.kind} database: ${relative.startsWith('..') ? store.file : relative}`);
  console.log(`  Gate app:      http://localhost:${PORT}`);
  console.log(`  Control room:  http://localhost:${PORT}/dashboard`);
  for (const addr of addresses) console.log(`  On network: ${addr}`);
});
