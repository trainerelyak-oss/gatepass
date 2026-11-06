const DB_NAME = 'patrolsync';
const DB_VERSION = 1;

let connection;

function open() {
  if (!connection) {
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const records = db.createObjectStore('records', { keyPath: 'id' });
        records.createIndex('syncStatus', 'syncStatus');
        records.createIndex('type', 'type');
        db.createObjectStore('meta');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return connection;
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function objectStore(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt);

export async function putRecord(record) {
  return done((await objectStore('records', 'readwrite')).put(record));
}

export async function getRecord(id) {
  return done((await objectStore('records')).get(id));
}

export async function allRecords() {
  const records = await done((await objectStore('records')).getAll());
  return records.sort(newestFirst);
}

export async function recordsByType(type) {
  const records = await done((await objectStore('records')).index('type').getAll(type));
  return records.sort(newestFirst);
}

export async function pendingRecords() {
  return done((await objectStore('records')).index('syncStatus').getAll('pending'));
}

export async function countPending() {
  return done((await objectStore('records')).index('syncStatus').count('pending'));
}

export async function markSynced(sent, syncedAt) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    for (const { id, revision } of sent) {
      store.get(id).onsuccess = event => {
        const record = event.target.result;
        if (record && record.syncStatus === 'pending' && record.revision === revision) {
          record.syncStatus = 'synced';
          record.syncedAt = syncedAt;
          store.put(record);
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getMeta(key) {
  return done((await objectStore('meta')).get(key));
}

export async function setMeta(key, value) {
  return done((await objectStore('meta', 'readwrite')).put(value, key));
}

export async function clearRecords() {
  return done((await objectStore('records', 'readwrite')).clear());
}
