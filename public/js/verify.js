import { getMeta } from './db.js';

const EARLY_ENTRY_MS = 30 * 60 * 1000;

const importedKeys = new Map();

function fromBase64Url(value) {
  let s = value.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

export function normaliseName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '');
}

export function normaliseId(partialId) {
  return String(partialId || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function isPartialId(value) {
  return /^\d{3}[A-Z]$/.test(normaliseId(value));
}

export function cryptoAvailable() {
  return Boolean(globalThis.crypto?.subtle);
}

async function importKey(id, jwk) {
  if (importedKeys.has(id)) return importedKeys.get(id);
  const key = await crypto.subtle.importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  importedKeys.set(id, key);
  return key;
}

async function signerKey(kind, keyId, cache) {
  if (kind === 'pass') return cache?.publicKey ? { key: await importKey(cache.keyId, cache.publicKey), label: `site key ${cache.keyId}` } : null;
  const own = await getMeta('deviceKey');
  if (own?.keyId === keyId) return { key: await importKey(keyId, own.jwk), label: 'issued by this device' };
  const known = cache?.deviceKeys?.find(k => k.keyId === keyId);
  return known ? { key: await importKey(keyId, known.jwk), label: `issued at ${known.postName || `Gate ${known.gate}`}` } : null;
}

export function decodePass(token) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3 || !['GP1', 'GT1'].includes(parts[0])) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1])));
    return {
      kind: parts[0] === 'GT1' ? 'temp' : 'pass',
      keyId: p.k || null,
      body: `${parts[0]}.${parts[1]}`,
      signature: parts[2],
      pass: {
        temporary: parts[0] === 'GT1',
        zones: p.z || [],
        escort: p.x === 1,
        reason: p.r || null,
        id: p.i,
        name: p.n,
        type: p.t,
        host: p.h,
        company: p.c || null,
        partialId: p.p || null,
        siteId: p.s,
        validFrom: new Date(p.f * 1000).toISOString(),
        validTo: new Date(p.e * 1000).toISOString(),
        multiEntry: p.m === 1
      }
    };
  } catch {
    return null;
  }
}

export async function verifyPass(token, siteId, now = Date.now()) {
  const decoded = decodePass(token);
  if (!decoded) {
    return { ok: false, pass: null, reason: 'Not a GatePass code', checks: [] };
  }

  const { pass } = decoded;
  const cache = await getMeta('siteCache');
  const checks = [];

  if (!cryptoAvailable()) {
    return { ok: false, pass, reason: 'Verification needs HTTPS. Open the app through https:// or localhost.', checks };
  }
  if (!cache?.publicKey && decoded.kind === 'pass') {
    return { ok: false, pass, reason: 'This device has no site key yet. Connect once so it can verify passes offline.', checks };
  }

  const signer = await signerKey(decoded.kind, decoded.keyId, cache);
  if (!signer) {
    checks.push({ ok: false, label: 'Genuine pass', detail: 'Temporary pass from a device this gate has not synced with yet' });
    return { ok: false, pass, reason: 'Cannot verify: issued by an unknown device. Call the issuing post or control room.', checks, unknownSigner: true };
  }

  let signed = false;
  try {
    signed = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      signer.key,
      fromBase64Url(decoded.signature),
      new TextEncoder().encode(decoded.body)
    );
  } catch {
    signed = false;
  }

  checks.push({ ok: signed, label: decoded.kind === 'temp' ? 'Genuine temporary pass' : 'Genuine pass', detail: signed ? `Signature valid · ${signer.label}` : 'Signature check failed. Pass is forged or has been edited' });
  if (!signed) return { ok: false, pass, reason: 'Forged or altered pass', checks };

  if (cache?.revoked?.includes(pass.id)) {
    checks.push({ ok: false, label: 'Not revoked', detail: 'Control room has revoked this pass' });
    return { ok: false, pass, reason: 'Pass revoked by control room', checks };
  }

  const siteOk = pass.siteId === siteId;
  checks.push({ ok: siteOk, label: 'Issued for this site', detail: siteOk ? pass.siteId : `Pass is for site ${pass.siteId}` });

  const from = new Date(pass.validFrom).getTime();
  const to = new Date(pass.validTo).getTime();
  const started = now >= from - EARLY_ENTRY_MS;
  const notExpired = now <= to;
  checks.push({
    ok: started && notExpired,
    label: 'Within visit window',
    detail: !started
      ? `Not valid until ${new Date(from).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
      : !notExpired
        ? `Expired ${new Date(to).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
        : `Until ${new Date(to).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  });

  const failed = checks.find(c => !c.ok);
  return { ok: !failed, pass, reason: failed ? failed.detail : null, checks };
}

export async function checkWatchlist(name, partialId) {
  const cache = await getMeta('siteCache');
  if (!cache?.watchlist?.entries?.length || !cryptoAvailable() || !name || !partialId) return null;
  const input = `${cache.watchlist.salt}|${normaliseName(name)}|${normaliseId(partialId)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  const hit = cache.watchlist.entries.find(entry => entry.h === hex);
  return hit ? { level: hit.level, ref: hex.slice(0, 12) } : null;
}
