const fs = require('fs');
const path = require('path');
const { getShares, saveShare } = require('./shares');
const { getUsers } = require('./users');
const { getGroups } = require('./groups');
const { getUserQuotas, setUserQuota } = require('./system');
const { getSambaGlobalConfig, saveSambaGlobalConfig } = require('./sambaConfig');
const { getLogs, logEvent } = require('./audit');

const SETTINGS_FILE = path.join(__dirname, '../data/settings.json');

function getSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      return {
        theme: 'dark',
        autoRefreshSec: 15,
        appName: 'NAS SMB Manager',
        enableAuditLogging: true
      };
    }
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    return { theme: 'dark', autoRefreshSec: 15, appName: 'NAS SMB Manager' };
  }
}

function saveSettings(newSettings, adminUser = 'admin') {
  const current = getSettings();
  const updated = { ...current, ...newSettings };
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf8');
  logEvent('config', 'Rendszerbeállítások frissítve', adminUser, updated);
  return updated;
}

// Export Full NAS Configuration
async function exportFullConfig() {
  const shares = getShares();
  const users = await getUsers();
  const groups = await getGroups();
  const quotas = getUserQuotas();
  const globalConfig = getSambaGlobalConfig();
  const settings = getSettings();

  let pkgVersion = '0.2.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    pkgVersion = pkg.version || '0.2.0';
  } catch (e) {}

  return {
    version: pkgVersion,
    exportedAt: new Date().toISOString(),
    globalConfig,
    shares,
    users: users.map(u => ({ username: u.username, fullName: u.fullName, groups: u.groups })),
    groups: groups.map(g => ({ name: g.name, members: g.members })),
    quotas,
    settings
  };
}

// Import Full NAS Configuration
async function importFullConfig(configData, adminUser = 'admin') {
  if (!configData || !configData.version) throw new Error('Érvénytelen konfigurációs fájl!');

  if (configData.globalConfig) {
    await saveSambaGlobalConfig(configData.globalConfig, adminUser);
  }

  if (Array.isArray(configData.shares)) {
    for (const s of configData.shares) {
      if (s.name && s.path) {
        await saveShare({
          name: s.name,
          folderPath: s.path,
          comment: s.comment,
          isPublic: s.isPublic,
          readOnly: s.readOnly,
          disabled: s.disabled,
          recycle: s.recycle,
          validUsers: s.validUsers,
          writeList: s.writeList
        }, adminUser).catch(() => {});
      }
    }
  }

  if (configData.quotas) {
    for (const [u, limitMB] of Object.entries(configData.quotas)) {
      await setUserQuota(u, limitMB);
    }
  }

  logEvent('config', 'Konfiguráció importálva', adminUser, { exportedAt: configData.exportedAt });
  return { success: true };
}

module.exports = { getSettings, saveSettings, exportFullConfig, importFullConfig };
