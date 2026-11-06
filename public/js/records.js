import { putRecord, getMeta } from './db.js';
import { isConnected, notifyChange } from './sync.js';

let lastPosition = null;

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function startLocationWatch() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    pos => {
      lastPosition = {
        lat: Number(pos.coords.latitude.toFixed(6)),
        lng: Number(pos.coords.longitude.toFixed(6)),
        accuracy: Math.round(pos.coords.accuracy),
        at: new Date(pos.timestamp).toISOString()
      };
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }
  );
}

export async function saveRecord(type, fields) {
  const guard = await getMeta('guard');
  const record = {
    id: uid(),
    type,
    revision: 1,
    createdAt: new Date().toISOString(),
    guardId: guard?.id || null,
    guardName: guard?.name || null,
    deviceId: await getMeta('deviceId'),
    recordedOffline: !isConnected(),
    location: lastPosition,
    ...((await getMeta('testMode')) ? { test: true } : {}),
    ...fields,
    syncStatus: 'pending'
  };
  await putRecord(record);
  notifyChange();
  return record;
}
