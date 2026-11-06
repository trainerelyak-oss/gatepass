const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DB_FILE = path.join(DATA_DIR, 'db.json');
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
  '/dashboard': 'dashboard.html'
};

fs.mkdirSync(PHOTO_DIR, { recursive: true });

const db = loadDb();
let writeChain = Promise.resolve();

function loadDb() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { records: data.records || {} };
  } catch {
    return { records: {} };
  }
}

function persist() {
  writeChain = writeChain
    .then(async () => {
      const tmp = `${DB_FILE}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(db));
      await fsp.rename(tmp, DB_FILE);
    })
    .catch(err => console.error('Failed to write database:', err));
  return writeChain;
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
  if (!Array.isArray(record.photos)) return [];
  const stored = [];
  for (const [index, photo] of record.photos.entries()) {
    const match = typeof photo === 'string' && photo.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
    if (!match) {
      if (typeof photo === 'string' && photo.startsWith('/photos/')) stored.push(photo);
      continue;
    }
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const name = `${record.id.replace(/[^a-zA-Z0-9-]/g, '')}-${index}.${ext}`;
    await fsp.writeFile(path.join(PHOTO_DIR, name), Buffer.from(match[2], 'base64'));
    stored.push(`/photos/${name}`);
  }
  return stored;
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
  const accepted = [];
  let changed = false;

  for (const record of incoming) {
    if (!record || typeof record.id !== 'string' || typeof record.type !== 'string') continue;
    const existing = db.records[record.id];
    const revision = Number(record.revision) || 1;
    if (existing && existing.revision >= revision) {
      accepted.push(record.id);
      continue;
    }
    const { syncStatus, syncedAt, ...clean } = record;
    db.records[record.id] = {
      ...clean,
      revision,
      photos: await storePhotos(record),
      deviceId: record.deviceId || body.deviceId || null,
      receivedAt: existing ? existing.receivedAt : receivedAt,
      updatedAt: receivedAt
    };
    accepted.push(record.id);
    changed = true;
  }

  if (changed) await persist();
  sendJson(res, 200, { accepted, serverTime: receivedAt });
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
  console.log(`PatrolSync running`);
  console.log(`  Guard app:  http://localhost:${PORT}`);
  console.log(`  Dashboard:  http://localhost:${PORT}/dashboard`);
  for (const addr of addresses) console.log(`  On network: ${addr}`);
});
