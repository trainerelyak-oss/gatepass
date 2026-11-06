const fs = require('fs');
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
    kind: 'SQLite',
    file,
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
    kind: 'JSON file',
    file,
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

function openStore(dataDir) {
  const DatabaseSync = process.env.GATEPASS_STORE === 'json' ? null : loadSqlite();
  return DatabaseSync ? sqliteStore(DatabaseSync, dataDir) : jsonStore(dataDir);
}

module.exports = { openStore, COLLECTIONS };
