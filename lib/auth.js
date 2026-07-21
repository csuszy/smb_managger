const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, '../data/app_config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
    setupCompleted: false,
    adminUsername: '',
    passwordHash: '',
    salt: '',
    adminAccounts: {},
    storageBasePath: '/srv/samba',
    sessionSecret: crypto.randomBytes(32).toString('hex')
  };
}

function saveConfig(cfg) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function hashPassword(password, salt = null) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, salt) {
  const { hash } = hashPassword(password, salt);
  return hash === storedHash;
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

// Simple token storage in memory
const activeSessions = new Map();

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 24 * 3600 * 1000; // 24h
  activeSessions.set(token, { username, expiresAt });
  return token;
}

function validateSession(token) {
  if (!token) return null;
  const session = activeSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return null;
  }
  return session;
}

function destroySession(token) {
  if (token) activeSessions.delete(token);
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
  createSession,
  validateSession,
  destroySession
};
