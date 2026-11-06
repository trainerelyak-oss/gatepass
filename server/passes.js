const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function loadSigningKey(dataDir) {
  const file = path.join(dataDir, 'signing-key.json');
  let privateJwk;
  let publicJwk;
  try {
    ({ privateJwk, publicJwk } = JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    privateJwk = pair.privateKey.export({ format: 'jwk' });
    publicJwk = pair.publicKey.export({ format: 'jwk' });
    fs.writeFileSync(file, JSON.stringify({ privateJwk, publicJwk }), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const keyId = crypto.createHash('sha256').update(publicJwk.x + publicJwk.y).digest('hex').slice(0, 8);
  return {
    keyId,
    publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y },
    sign(body) {
      return crypto.sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    }
  };
}

function passCode() {
  const bytes = crypto.randomBytes(6);
  return [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function issuePass(key, invite, siteId) {
  const payload = {
    i: invite.id,
    n: invite.name,
    t: invite.type,
    h: invite.host,
    s: siteId,
    f: Math.floor(new Date(invite.validFrom).getTime() / 1000),
    e: Math.floor(new Date(invite.validTo).getTime() / 1000),
    m: invite.multiEntry ? 1 : 0
  };
  if (invite.company) payload.c = invite.company;
  if (invite.zones?.length) payload.z = invite.zones;
  if (invite.escort) payload.x = 1;
  if (invite.partialId) payload.p = invite.partialId;
  const body = `GP1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${body}.${key.sign(body)}`;
}

function normaliseName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '');
}

function normaliseId(partialId) {
  return String(partialId || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function watchlistHash(salt, name, partialId) {
  return crypto.createHash('sha256').update(`${salt}|${normaliseName(name)}|${normaliseId(partialId)}`).digest('hex');
}

module.exports = { loadSigningKey, passCode, issuePass, watchlistHash };
