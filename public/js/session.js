import { getMeta, setMeta } from './db.js';
import { toBase64Url } from './devicekey.js';

let token = null;

export async function loadSession() {
  const session = await getMeta('session');
  token = session?.token || null;
  return session || null;
}

export function authHeaders(extra = {}) {
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150000 }, key, 256);
  return toBase64Url(bits);
}

async function rememberForOffline(username, password, session) {
  if (!globalThis.crypto?.subtle) return;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const remembered = (await getMeta('offlineLogins')) || {};
  remembered[username] = {
    salt: toBase64Url(salt),
    hash: await passwordHash(password, salt),
    session,
    savedAt: new Date().toISOString()
  };
  await setMeta('offlineLogins', remembered);
}

function fromBase64Url(value) {
  let s = value.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

export async function signIn(username, password) {
  const name = String(username || '').trim().toLowerCase();
  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password }),
      signal: controller.signal
    }).finally(() => clearTimeout(timer));
  } catch {
    return signInOffline(name, password);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Sign in failed');
  const session = { token: body.token, user: body.user, offline: false };
  await setMeta('session', session);
  token = session.token;
  await rememberForOffline(name, password, session);
  return session;
}

async function signInOffline(username, password) {
  const remembered = (await getMeta('offlineLogins')) || {};
  const entry = remembered[username];
  if (!entry || !globalThis.crypto?.subtle) {
    throw new Error('No connection. The first sign-in on a device needs the internet.');
  }
  const hash = await passwordHash(password, fromBase64Url(entry.salt));
  if (hash !== entry.hash) throw new Error('Wrong username or password');
  const session = { ...entry.session, offline: true };
  await setMeta('session', session);
  token = session.token;
  return session;
}

export async function signOut() {
  token = null;
  await setMeta('session', null);
}

export async function canRemember(username) {
  const remembered = (await getMeta('offlineLogins')) || {};
  return Boolean(remembered[String(username || '').trim().toLowerCase()]);
}
