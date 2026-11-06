const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const COLLECTIONS = ['records', 'invites', 'devices', 'deviceKeys', 'reviews'];

function loadSqlite() {
  const listeners = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', warning => {
    if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
    for (const listener of listeners) listener(warning);
  });
  try {
    return require('node:sqlite').DatabaseSync;
  } catch {
    return null;
  }
}

function legacyJson(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  } catch {
    return null;
  }
}

function fileBlobs(dataDir) {
  const dir = path.join(dataDir, 'photos');
  fs.mkdirSync(dir, { recursive: true });
  const safe = name => path.join(dir, path.basename(name));
  return {
    async putBlob(name, bytes) {
      await fsp.writeFile(safe(name), bytes);
    },
    async getBlob(name) {
      try {
        return await fsp.readFile(safe(name));
      } catch {
        return null;
      }
    },
    async clearBlobs() {
      for (const file of await fsp.readdir(dir).catch(() => [])) await fsp.unlink(path.join(dir, file)).catch(() => {});
    }
  };
}

function sqliteStore(DatabaseSync, dataDir) {
  const file = path.join(dataDir, 'gatepass.sqlite');
  const fresh = !fs.existsSync(file);
  const sql = new DatabaseSync(file);
  sql.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  for (const name of COLLECTIONS) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }
  sql.exec(`
    CREATE TABLE IF NOT EXISTS record_index (id TEXT PRIMARY KEY, type TEXT, created_at TEXT, device_id TEXT);
    CREATE INDEX IF NOT EXISTS record_type ON record_index (type, created_at);
  `);

  const upserts = Object.fromEntries(COLLECTIONS.map(name => [
    name,
    sql.prepare(`INSERT INTO ${name} (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
  ]));
  const indexRecord = sql.prepare('INSERT INTO record_index (id, type, created_at, device_id) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, created_at = excluded.created_at, device_id = excluded.device_id');
  const setMetaStmt = sql.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  let depth = 0;

  const store = {
    ...fileBlobs(dataDir),
    kind: 'SQLite',
    location: file,
    async flush() {},
    load() {
      const data = {};
      for (const name of COLLECTIONS) {
        data[name] = {};
        for (const row of sql.prepare(`SELECT id, data FROM ${name}`).all()) data[name][row.id] = JSON.parse(row.data);
      }
      for (const row of sql.prepare('SELECT key, value FROM meta').all()) data[row.key] = JSON.parse(row.value);
      return data;
    },
    put(collection, id, value) {
      upserts[collection].run(id, JSON.stringify(value), new Date().toISOString());
      if (collection === 'records') indexRecord.run(id, value.type || null, value.createdAt || null, value.deviceId || null);
    },
    setMeta(key, value) {
      setMetaStmt.run(key, JSON.stringify(value));
    },
    clear(collection) {
      sql.exec(`DELETE FROM ${collection}`);
      if (collection === 'records') sql.exec('DELETE FROM record_index');
    },
    transaction(fn) {
      if (depth > 0) return fn();
      depth++;
      sql.exec('BEGIN');
      try {
        const result = fn();
        sql.exec('COMMIT');
        return result;
      } catch (err) {
        sql.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    }
  };

  if (fresh) {
    const legacy = legacyJson(dataDir);
    if (legacy) {
      store.transaction(() => {
        for (const name of COLLECTIONS) {
          for (const [id, value] of Object.entries(legacy[name] || {})) store.put(name, id, value);
        }
        if (legacy.salt) store.setMeta('salt', legacy.salt);
        if (legacy.epoch) store.setMeta('epoch', legacy.epoch);
      });
      console.log('  Imported existing data from db.json');
    }
  }

  return store;
}

function jsonStore(dataDir) {
  const file = path.join(dataDir, 'db.json');
  const data = legacyJson(dataDir) || {};
  for (const name of COLLECTIONS) data[name] = data[name] || {};
  let timer = null;

  const flush = () => {
    timer = null;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, 50);
  };
  process.on('exit', () => timer && flush());

  return {
    ...fileBlobs(dataDir),
    kind: 'JSON file',
    location: file,
    async flush() {
      if (timer) {
        clearTimeout(timer);
        flush();
      }
    },
    load: () => JSON.parse(JSON.stringify(data)),
    put(collection, id, value) {
      data[collection][id] = value;
      schedule();
    },
    setMeta(key, value) {
      data[key] = value;
      schedule();
    },
    clear(collection) {
      data[collection] = {};
      schedule();
    },
    transaction: fn => fn()
  };
}

const SUPABASE_TABLES = {
  records: 'gp_records',
  invites: 'gp_invites',
  devices: 'gp_devices',
  deviceKeys: 'gp_device_keys',
  reviews: 'gp_reviews',
  meta: 'gp_meta',
  photos: 'gp_photos'
};

async function supabaseStore(baseUrl, key) {
  const api = `${baseUrl.replace(/\/+$/, '')}/rest/v1`;
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;

  const pending = Object.fromEntries(Object.keys(SUPABASE_TABLES).map(name => [name, new Map()]));
  const clearing = new Set();
  let flushing = null;
  let timer = null;
  let failures = 0;

  async function request(method, pathAndQuery, body, extra = {}) {
    let res;
    try {
      res = await fetch(`${api}/${pathAndQuery}`, {
        method,
        headers: { ...headers, ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      });
    } catch (err) {
      const wrapped = new Error(`Could not reach Supabase at ${baseUrl} (${err.cause?.code || err.message}). Check SUPABASE_URL.`);
      wrapped.network = true;
      throw wrapped;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Supabase ${method} ${pathAndQuery.split('?')[0]} failed (${res.status}): ${text.slice(0, 200)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  async function selectAll(name) {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await request('GET', `${SUPABASE_TABLES[name]}?select=id,data&order=id&limit=1000&offset=${offset}`);
      rows.push(...page);
      if (page.length < 1000) return rows;
    }
  }

  async function flushNow() {
    for (const name of Object.keys(SUPABASE_TABLES)) {
      if (clearing.has(name)) {
        await request('DELETE', `${SUPABASE_TABLES[name]}?id=not.is.null`, undefined, { Prefer: 'return=minimal' });
        clearing.delete(name);
      }
      const queue = pending[name];
      while (queue.size) {
        const batch = [...queue.entries()].slice(0, 200);
        const rows = batch.map(([id, row]) => ({ id, ...row, updated_at: new Date().toISOString() }));
        await request('POST', SUPABASE_TABLES[name], rows, { Prefer: 'resolution=merge-duplicates,return=minimal' });
        for (const [id, row] of batch) if (queue.get(id) === row) queue.delete(id);
      }
    }
  }

  function schedule(delay = 150) {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushing = (flushing || Promise.resolve())
        .then(flushNow)
        .then(() => {
          if (failures) console.log('  Database connection restored, all changes saved');
          failures = 0;
        })
        .catch(err => {
          failures++;
          if (failures === 1 || failures % 10 === 0) console.error(`  Could not save to Supabase, will retry: ${err.message}`);
          schedule(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
        })
        .finally(() => {
          flushing = null;
        });
    }, delay);
  }

  try {
    await request('GET', `${SUPABASE_TABLES.meta}?select=id&limit=1`);
  } catch (err) {
    if (err.status === 404 || /PGRST205|42P01|does not exist|schema cache/i.test(err.body || '')) {
      throw new Error('Supabase tables not found. Open your Supabase project > SQL Editor, paste supabase/schema.sql from this repo and click Run.');
    }
    if (err.status === 401 || err.status === 403) {
      throw new Error('Supabase rejected the key. Use the secret key (sb_secret_...) from Project Settings > API Keys.');
    }
    throw err;
  }

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      try {
        await store.flush();
      } catch (err) {
        console.error(`  Some changes could not be saved: ${err.message}`);
      } finally {
        process.exit(0);
      }
    });
  }

  const store = {
    kind: 'Supabase',
    location: baseUrl,
    async load() {
      const data = {};
      for (const name of COLLECTIONS) {
        data[name] = {};
        for (const row of await selectAll(name)) data[name][row.id] = row.data;
      }
      for (const row of await selectAll('meta')) data[row.id] = row.data;
      return data;
    },
    put(collection, id, value) {
      pending[collection].set(id, { data: value });
      schedule();
    },
    setMeta(key, value) {
      pending.meta.set(key, { data: value });
      schedule();
    },
    clear(collection) {
      pending[collection].clear();
      clearing.add(collection);
      schedule();
    },
    transaction: fn => fn(),
    async putBlob(name, bytes, contentType = 'image/jpeg') {
      pending.photos.set(name, { content_type: contentType, data: Buffer.from(bytes).toString('base64') });
      schedule(0);
    },
    async getBlob(name) {
      const queued = pending.photos.get(name);
      if (queued) return Buffer.from(queued.data, 'base64');
      const rows = await request('GET', `${SUPABASE_TABLES.photos}?select=data&id=eq.${encodeURIComponent(name)}`);
      return rows?.[0] ? Buffer.from(rows[0].data, 'base64') : null;
    },
    async clearBlobs() {
      this.clear('photos');
    },
    async flush() {
      clearTimeout(timer);
      timer = null;
      if (flushing) await flushing.catch(() => {});
      await flushNow();
    }
  };
  return store;
}

async function openStore(dataDir) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (url && key) return supabaseStore(url, key);
  const DatabaseSync = process.env.GATEPASS_STORE === 'json' ? null : loadSqlite();
  return DatabaseSync ? sqliteStore(DatabaseSync, dataDir) : jsonStore(dataDir);
}

module.exports = { openStore, COLLECTIONS };
