const crypto = require('crypto');

const ROLES = {
  officer: { rank: 1, label: 'Security officer' },
  supervisor: { rank: 2, label: 'Supervisor' },
  admin: { rank: 3, label: 'Admin' }
};

const SESSION_DAYS = 7;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function createTokens(secret) {
  const key = Buffer.from(secret, 'base64');
  const sign = body => crypto.createHmac('sha256', key).update(body).digest('base64url');
  return {
    issue(user) {
      const payload = { uid: user.id, role: user.role, ver: user.tokenVersion || 0, exp: Date.now() + SESSION_DAYS * 86400000 };
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${body}.${sign(body)}`;
    },
    read(token) {
      const [body, mac] = String(token || '').split('.');
      if (!body || !mac) return null;
      const expected = sign(body);
      if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
      try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return payload.exp > Date.now() ? payload : null;
      } catch {
        return null;
      }
    }
  };
}

function hasRole(user, minimum) {
  return Boolean(user && ROLES[user.role] && ROLES[user.role].rank >= ROLES[minimum].rank);
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, tokenVersion, ...rest } = user;
  return { ...rest, roleLabel: ROLES[user.role]?.label || user.role };
}

function normaliseUsername(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
}

module.exports = { ROLES, hashPassword, verifyPassword, createTokens, hasRole, publicUser, normaliseUsername };
