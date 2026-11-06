import { getMeta, setMeta } from './db.js';

export function toBase64Url(bytes) {
  let binary = '';
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function deviceKey() {
  if (!globalThis.crypto?.subtle) return null;
  let key = await getMeta('deviceKey');
  if (key) return key;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  key = {
    keyId: `d${(await sha256Hex(jwk.x + jwk.y)).slice(0, 8)}`,
    privateKey: pair.privateKey,
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    registered: false
  };
  await setMeta('deviceKey', key);
  return key;
}

export async function registerDeviceKey(device, headers = {}) {
  const key = await deviceKey();
  if (!key || key.registered) return;
  const res = await fetch('/api/devices/key', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: device.deviceId, keyId: key.keyId, jwk: key.jwk, gate: device.gate, postName: device.postName })
  });
  if (res.ok) await setMeta('deviceKey', { ...key, registered: true });
}

export async function signTempPass(payload) {
  const key = await deviceKey();
  if (!key) throw new Error('This browser cannot sign passes. Open the app over HTTPS or localhost.');
  const body = `GT1.${toBase64Url(new TextEncoder().encode(JSON.stringify({ ...payload, k: key.keyId })))}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(body));
  return { token: `${body}.${toBase64Url(signature)}`, keyId: key.keyId };
}

export async function photoFingerprint(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return sha256Hex(bytes);
}
