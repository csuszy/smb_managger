const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, '../data/app_config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (!cfg.sessionSecret) {
        cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
        saveConfig(cfg);
      }
      return cfg;
    }
  } catch (e) {}
  const newCfg = {
    setupCompleted: false,
    adminUsername: '',
    passwordHash: '',
    salt: '',
    adminAccounts: {},
    storageBasePath: '/srv/samba',
    sessionSecret: crypto.randomBytes(32).toString('hex')
  };
  saveConfig(newCfg);
  return newCfg;
}

function saveConfig(cfg) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

const REVOKED_TOKENS_FILE = path.join(__dirname, '../data/revoked_tokens.json');

function loadRevokedTokens() {
  try {
    if (fs.existsSync(REVOKED_TOKENS_FILE)) {
      const list = JSON.parse(fs.readFileSync(REVOKED_TOKENS_FILE, 'utf8'));
      return new Set(list);
    }
  } catch (e) {}
  return new Set();
}

const revokedTokens = loadRevokedTokens();

function saveRevokedTokens() {
  try {
    const dir = path.dirname(REVOKED_TOKENS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REVOKED_TOKENS_FILE, JSON.stringify(Array.from(revokedTokens)), 'utf8');
  } catch (e) {}
}

const PBKDF2_ITERATIONS = 310000;

function hashPassword(password, salt = null) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, salt) {
  if (!password || !storedHash || !salt) return false;
  const { hash } = hashPassword(password, salt);
  const bufA = Buffer.from(hash, 'utf8');
  const bufB = Buffer.from(storedHash, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getAdminAccounts(cfg) {
  if (!cfg.adminAccounts) cfg.adminAccounts = {};
  if (cfg.adminUsername && cfg.passwordHash && !cfg.adminAccounts[cfg.adminUsername]) {
    cfg.adminAccounts[cfg.adminUsername] = {
      passwordHash: cfg.passwordHash,
      salt: cfg.salt
    };
  }
  return cfg.adminAccounts;
}

function verifyAdminCredentials(username, password) {
  const cfg = loadConfig();
  const accounts = getAdminAccounts(cfg);
  const userAcc = accounts[username];

  if (!userAcc) return false;
  return verifyPassword(password, userAcc.passwordHash, userAcc.salt);
}

function addOrUpdateAdminAccount(username, password) {
  const cfg = loadConfig();
  const accounts = getAdminAccounts(cfg);
  const { hash, salt } = hashPassword(password);

  accounts[username] = { passwordHash: hash, salt };
  cfg.adminAccounts = accounts;

  if (!cfg.adminUsername || username === cfg.adminUsername) {
    cfg.adminUsername = username;
    cfg.passwordHash = hash;
    cfg.salt = salt;
  }

  saveConfig(cfg);
}

function removeAdminAccount(username) {
  const cfg = loadConfig();
  const accounts = getAdminAccounts(cfg);
  if (accounts[username]) {
    delete accounts[username];
    cfg.adminAccounts = accounts;
    saveConfig(cfg);
  }
}

function isUserAdmin(username) {
  const cfg = loadConfig();
  const accounts = getAdminAccounts(cfg);
  return !!accounts[username];
}

// =========================================================
// JWT (JSON Web Token) Implementation (Zero Dependency)
// =========================================================
function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function createJwt(payload, expiresInDays = 30) {
  const cfg = loadConfig();
  const secret = cfg.sessionSecret;
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + (expiresInDays * 24 * 3600);
  const fullPayload = { ...payload, exp, iat: Math.floor(Date.now() / 1000) };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function isTokenRevoked(token) {
  if (!token || typeof token !== 'string') return true;
  return revokedTokens.has(token.trim());
}

function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  const trimmedToken = token.trim();
  if (isTokenRevoked(trimmedToken)) return null;

  const cfg = loadConfig();
  const secret = cfg.sessionSecret;

  const parts = trimmedToken.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const sigBuf = Buffer.from(signature, 'utf8');
  const expSigBuf = Buffer.from(expectedSignature, 'utf8');
  if (sigBuf.length !== expSigBuf.length || !crypto.timingSafeEqual(sigBuf, expSigBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null;
    }
    return payload;
  } catch (e) {
    return null;
  }
}

function createSession(username) {
  return createJwt({ username }, 30); // 30 days JWT token
}

function validateSession(token) {
  const payload = verifyJwt(token);
  if (!payload) return null;
  return { username: payload.username };
}

function destroySession(token) {
  if (!token || typeof token !== 'string') return;
  revokedTokens.add(token.trim());
  saveRevokedTokens();
}

module.exports = {
  loadConfig,
  saveConfig,
  hashPassword,
  verifyPassword,
  verifyAdminCredentials,
  addOrUpdateAdminAccount,
  removeAdminAccount,
  isUserAdmin,
  createJwt,
  verifyJwt,
  createSession,
  validateSession,
  destroySession,
  PBKDF2_ITERATIONS,
  isTokenRevoked
};
