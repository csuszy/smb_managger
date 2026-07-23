const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Import modular backend libraries
const { getSystemInfo, getStorageInfo, getUserQuotas, setUserQuota } = require('./lib/system');
const { getUsers, createUser, updateUser, changePassword, toggleUser, deleteUser } = require('./lib/users');
const { getGroups, createGroup, deleteGroup, addUserToGroup, removeUserFromGroup } = require('./lib/groups');
const { getShares, saveShare, toggleShare, deleteShare } = require('./lib/shares');
const { getFolderPermissions, saveFolderPermissions } = require('./lib/permissions');
const { getActiveConnections, killConnection } = require('./lib/connections');
const { getRecycleFiles, restoreRecycleFile, restoreRecycleFiles, deleteRecycleFile, deleteRecycleFiles, emptyRecycleBin } = require('./lib/recycle');
const {
  getSnapshots,
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  loadSnapshotConfig,
  saveSnapshotConfig
} = require('./lib/snapshots');
const { getSambaGlobalConfig, saveSambaGlobalConfig, ensureDefaultHomesSection } = require('./lib/sambaConfig');
const { getSettings, saveSettings, exportFullConfig, importFullConfig } = require('./lib/settings');
const { checkVersion, getChangelog, getReleases, applySystemUpdate } = require('./lib/version');
const audit = require('./lib/audit');
const {
  loadNotifConfig,
  saveNotifConfig,
  sendDiscordWebhook,
  sendSmtpEmail,
  notifyEvent
} = require('./lib/notifications');
const {
  loadPrinterConfig,
  savePrinterConfig,
  getPrinters,
  scanNetworkPrinters,
  addManualPrinter,
  removeManualPrinter,
  installCupsPackages,
  printFile,
  startFolderPrintWatcher,
  checkImapEmailAccount
} = require('./lib/printers');

const {
  loadConfig,
  saveConfig,
  hashPassword,
  verifyPassword,
  verifyAdminCredentials,
  createSession,
  validateSession,
  destroySession
} = require('./lib/auth');

const app = express();
const PORT = 8080;

function getSambaBase() {
  const cfg = loadConfig();
  const basePath = cfg.storageBasePath || '/srv/samba';
  if (!fs.existsSync(basePath)) {
    try { fs.mkdirSync(basePath, { recursive: true }); } catch (e) {}
  }
  return basePath;
}

// Guarantee default [homes] section and permissions
ensureDefaultHomesSection(getSambaBase()).catch(e => console.error(e));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

// Helper to extract JWT token from Authorization header or X-Auth-Token header
function extractToken(req) {
  let token = req.headers['authorization'] || req.headers['x-auth-token'] || req.query.token;
  if (token && typeof token === 'string' && token.startsWith('Bearer ')) {
    token = token.slice(7).trim();
  }
  return token;
}

// ============================
// AUTHENTICATION & INITIAL SETUP
// ============================
app.get('/api/auth/status', (req, res) => {
  const cfg = loadConfig();
  const token = extractToken(req);
  const session = validateSession(token);

  res.json({
    setupCompleted: !!cfg.setupCompleted,
    authenticated: !!session,
    username: session ? session.username : null,
    storageBasePath: cfg.storageBasePath || '/srv/samba'
  });
});

app.post('/api/auth/setup', async (req, res) => {
  const cfg = loadConfig();
  if (cfg.setupCompleted) {
    return res.status(400).json({ error: 'A rendszer telepítése már megtörtént!' });
  }

  const { username, password, storageBasePath } = req.body;
  if (!username || !/^[a-zA-Z0-9_.-]+$/.test(username.trim())) {
    return res.status(400).json({ error: 'Érvénytelen adminisztrátori felhasználónév!' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'A jelszónak legalább 4 karakteresnek kell lennie!' });
  }

  const baseDir = (storageBasePath && storageBasePath.trim()) ? path.resolve(storageBasePath.trim()) : '/srv/samba';
  if (!fs.existsSync(baseDir)) {
    try { fs.mkdirSync(baseDir, { recursive: true }); } catch (e) {}
  }

  const { hash, salt } = hashPassword(password);
  cfg.setupCompleted = true;
  cfg.adminUsername = username.trim();
  cfg.passwordHash = hash;
  cfg.salt = salt;
  cfg.storageBasePath = baseDir;
  saveConfig(cfg);

  try {
    await ensureDefaultHomesSection(baseDir);
  } catch (e) {
    console.error('Failed to configure default homes section during setup:', e);
  }

  try {
    await createUser({ username: username.trim(), password, fullName: 'System Administrator' }).catch(() => {});
  } catch (e) {}

  const token = createSession(username.trim());
  audit.logEvent('auth', `Rendszer sikeresen telepítve, admin: ${username}`, username);

  res.json({
    success: true,
    message: 'Telepítés sikeres!',
    token,
    username: username.trim(),
    storageBasePath: baseDir
  });
});

app.post('/api/auth/login', (req, res) => {
  const cfg = loadConfig();
  if (!cfg.setupCompleted) {
    return res.status(428).json({ error: 'Rendszer telepítése szükséges!', setupRequired: true });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Felhasználónév és jelszó kötelező!' });
  }

  if (!verifyAdminCredentials(username.trim(), password)) {
    audit.logEvent('auth', `Hibás bejelentkezési kísérlet: ${username}`, 'guest');
    return res.status(401).json({ error: 'Hibás felhasználónév vagy jelszó, vagy nincs Admin bejelentkezési jogosultságod!' });
  }

  const token = createSession(username.trim());
  audit.logEvent('auth', `Sikeres bejelentkezés: ${username}`, username);

  res.json({
    success: true,
    token,
    username: username.trim(),
    storageBasePath: cfg.storageBasePath || '/srv/samba'
  });
});

app.post('/api/auth/logout', (req, res) => {
  const token = extractToken(req);
  destroySession(token);
  res.json({ success: true });
});

app.put('/api/auth/change-admin-password', (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const cfg = loadConfig();

    if (!verifyPassword(currentPassword, cfg.passwordHash, cfg.salt)) {
      return res.status(400).json({ error: 'A jelenlegi jelszó helytelen!' });
    }

    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'Az új jelszónak legalább 4 karakteresnek kell lennie!' });
    }

    const { hash, salt } = hashPassword(newPassword);
    cfg.passwordHash = hash;
    cfg.salt = salt;
    saveConfig(cfg);

    audit.logEvent('auth', 'Adminisztrátori jelszó sikeresen módosítva', cfg.adminUsername || 'admin');
    res.json({ success: true, message: 'Adminisztrátori jelszó sikeresen megváltoztatva!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/auth/storage-path', (req, res) => {
  const { storageBasePath } = req.body;
  if (!storageBasePath || !storageBasePath.trim()) {
    return res.status(400).json({ error: 'A tárhely útvonal megadása kötelező!' });
  }

  const absPath = path.resolve(storageBasePath.trim());
  if (!fs.existsSync(absPath)) {
    try {
      fs.mkdirSync(absPath, { recursive: true });
    } catch (e) {
      return res.status(400).json({ error: 'Nem sikerült a tárhely mappát létrehozni: ' + e.message });
    }
  }

  const cfg = loadConfig();
  cfg.storageBasePath = absPath;
  saveConfig(cfg);

  // Apply new storage path to Samba [homes] config immediately
  ensureDefaultHomesSection(absPath).catch(e => console.error(e));

  audit.logEvent('config', `Megfigyelt tárhely útvonala módosítva: ${absPath}`, 'admin');
  res.json({ success: true, storageBasePath: absPath });
});

// Middleware for securing /api/* endpoints
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/status') || req.path.startsWith('/auth/setup') || req.path.startsWith('/auth/login')) {
    return next();
  }

  const cfg = loadConfig();
  if (!cfg.setupCompleted) {
    return res.status(428).json({ error: 'Rendszer telepítése szükséges!', setupRequired: true });
  }

  const token = extractToken(req);
  const session = validateSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Hitelesítés szükséges!' });
  }

  req.user = session.username;
  next();
});

// ============================
// 1. DASHBOARD
// ============================
app.get('/api/dashboard', async (req, res) => {
  try {
    const sambaBase = getSambaBase();
    const sysInfo = await getSystemInfo();
    const storageInfo = await getStorageInfo(sambaBase);
    const users = await getUsers();
    const groups = await getGroups();
    const shares = getShares();
    const connections = await getActiveConnections();

    let smbActive = 'inactive';
    try { smbActive = (await run('systemctl is-active smbd 2>/dev/null || echo inactive')).trim(); } catch (e) {}

    let smbEnabled = 'unknown';
    try { smbEnabled = (await run('systemctl is-enabled smbd 2>/dev/null || echo unknown')).trim(); } catch (e) {}

    res.json({
      system: sysInfo,
      storage: storageInfo,
      counts: {
        users: users.length,
        groups: groups.length,
        shares: shares.length,
        connections: connections.length
      },
      service: {
        active: smbActive,
        enabled: smbEnabled
      },
      connections
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Dashboard adatok betöltése sikertelen' });
  }
});

// ============================
// 2. USERS MANAGEMENT
// ============================
app.get('/api/users', async (req, res) => {
  try {
    const users = await getUsers();
    const quotas = getUserQuotas();
    const result = users.map(u => ({
      ...u,
      quotaMB: quotas[u.username] || 0
    }));
    res.json({ users: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const result = await createUser(req.body);
    if (req.body.quotaMB !== undefined) {
      await setUserQuota(result.username || req.body.username, req.body.quotaMB);
    }
    notifyEvent('users', '👤 Új Felhasználó Létrehozva', `Új Samba/rendszer felhasználó lett létrehozva: ${result.username}`, 0x10b981).catch(() => {});
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/users/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const result = await updateUser(username, req.body);
    if (req.body.quotaMB !== undefined) {
      await setUserQuota(username, req.body.quotaMB);
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/users/:username/password', async (req, res) => {
  try {
    const { username } = req.params;
    const { password } = req.body;
    const result = await changePassword(username, password);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/users/:username/toggle', async (req, res) => {
  try {
    const { username } = req.params;
    const { enable } = req.body;
    const result = await toggleUser(username, enable);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/users/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const result = await deleteUser(username);
    notifyEvent('users', '🗑️ Felhasználó Törölve', `Felhasználó törölve a rendszerből: ${username}`, 0xef4444).catch(() => {});
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================
// 3. GROUPS MANAGEMENT
// ============================
app.get('/api/groups', async (req, res) => {
  try {
    const groups = await getGroups();
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/groups', async (req, res) => {
  try {
    const { name } = req.body;
    const result = await createGroup(name);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/groups/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await deleteGroup(name);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/groups/:name/members', async (req, res) => {
  try {
    const { name } = req.params;
    const { username, action } = req.body; // action: 'add' | 'remove'
    if (action === 'remove') {
      await removeUserFromGroup(username, name);
    } else {
      await addUserToGroup(username, name);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================
// 4. SHARES MANAGEMENT
// ============================
app.get('/api/shares', async (req, res) => {
  try {
    const shares = getShares();
    res.json({ shares });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/shares', async (req, res) => {
  try {
    const result = await saveShare(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/shares/:name/toggle', async (req, res) => {
  try {
    const { name } = req.params;
    const { enable } = req.body;
    const result = await toggleShare(name, enable);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/shares/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const result = await deleteShare(name);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================
// 5. PERMISSIONS MANAGEMENT
// ============================
app.get('/api/permissions', async (req, res) => {
  try {
    const { folderPath } = req.query;
    if (!folderPath) return res.status(400).json({ error: 'folderPath kötelező!' });
    const result = await getFolderPermissions(folderPath);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/permissions', async (req, res) => {
  try {
    const { folderPath, userPermissions, groupPermissions } = req.body;
    const result = await saveFolderPermissions(folderPath, { userPermissions, groupPermissions });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================
// 6. ACTIVE CONNECTIONS
// ============================
app.get('/api/connections', async (req, res) => {
  try {
    const connections = await getActiveConnections();
    res.json({ connections });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/connections/:pid', async (req, res) => {
  try {
    const { pid } = req.params;
    const result = await killConnection(pid);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================
// 7. AUDIT LOGGING
// ============================
app.get('/api/audit', async (req, res) => {
  try {
    const { category, user, search, limit } = req.query;
    const logs = audit.filterLogs({ category, user, search, limit });
    res.json({ logs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================
// 8. STORAGE & QUOTAS
// ============================
app.get('/api/storage', async (req, res) => {
  try {
    const sambaBase = getSambaBase();
    const storage = await getStorageInfo(sambaBase);
    const quotas = getUserQuotas();
    res.json({ storage, quotas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/storage/quotas/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const { limitMB } = req.body;
    const quotas = await setUserQuota(username, limitMB);
    audit.logEvent('config', `Kvóta beállítva (${username}: ${limitMB || 0} MB)`, 'admin');
    res.json({ success: true, quotas });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================
// 9. SAMBA CONFIG (GUI)
// ============================
app.get('/api/samba-config', async (req, res) => {
  try {
    const settings = getSambaGlobalConfig();
    const rawContent = fs.readFileSync('/etc/samba/smb.conf', 'utf8');
    res.json({ settings, rawContent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/samba-config', async (req, res) => {
  try {
    const result = await saveSambaGlobalConfig(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/samba-config/raw', async (req, res) => {
  const { content } = req.body;
  if (content === undefined || content === null) {
    return res.status(400).json({ error: 'A konfiguráció tartalmának megadása kötelező!' });
  }

  const SMB_CONF = '/etc/samba/smb.conf';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${SMB_CONF}.backup-${timestamp}`;

  try {
    // Backup existing
    fs.copyFileSync(SMB_CONF, backupPath);

    // Write new content
    fs.writeFileSync(SMB_CONF, content, 'utf8');

    // Validate with testparm
    try {
      await run('testparm -s 2>&1');
    } catch (e) {
      // Restore on failure
      fs.copyFileSync(backupPath, SMB_CONF);
      return res.status(400).json({ error: 'A konfiguráció érvénytelen (testparm hiba): ' + e.message });
    }

    // Restart Samba service to apply changes
    await run('systemctl restart smbd nmbd 2>/dev/null || service smbd restart 2>/dev/null').catch(() => {});

    audit.logEvent('config', 'Samba konfigurációs fájl manuálisan módosítva (smb.conf)', req.user || 'admin');

    res.json({ success: true, message: 'Konfiguráció elmentve és Samba újraindítva!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================
// 10. RECYCLE BIN
// ============================
app.get('/api/recycle', async (req, res) => {
  try {
    const files = await getRecycleFiles();
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/recycle/:id/restore', async (req, res) => {
  try {
    const result = await restoreRecycleFile(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/recycle/:id', async (req, res) => {
  try {
    const result = await deleteRecycleFile(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/recycle/bulk-restore', async (req, res) => {
  try {
    const { ids } = req.body;
    const result = await restoreRecycleFiles(ids || []);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/recycle/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    const result = await deleteRecycleFiles(ids || []);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/recycle/empty', async (req, res) => {
  try {
    const result = await emptyRecycleBin();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================
// FILE BROWSER API
// ============================
app.get('/api/file-browser', async (req, res) => {
  try {
    const sambaBase = getSambaBase();
    let reqPath = req.query.path ? path.resolve(req.query.path) : sambaBase;
    if (!reqPath.startsWith(sambaBase) || !fs.existsSync(reqPath)) {
      reqPath = sambaBase;
    }

    const entries = fs.readdirSync(reqPath, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const itemPath = path.join(reqPath, entry.name);
      try {
        const stat = fs.statSync(itemPath);
        items.push({
          name: entry.name,
          path: itemPath,
          isDirectory: entry.isDirectory(),
          size: stat.size,
          modified: stat.mtime
        });
      } catch (e) {}
    }

    const parentPath = (reqPath !== sambaBase && reqPath.startsWith(sambaBase)) ? path.dirname(reqPath) : null;
    res.json({ currentPath: reqPath, parentPath, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/folders/create', async (req, res) => {
  try {
    const sambaBase = getSambaBase();
    const { basePath, name } = req.body;
    if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name.trim())) {
      return res.status(400).json({ error: 'Érvénytelen mappanév!' });
    }
    const resolvedBase = path.resolve(basePath || sambaBase);
    if (!resolvedBase.startsWith(sambaBase)) {
      return res.status(403).json({ error: 'Mappa csak a megfigyelt gyökérkönyvtárban hozható létre!' });
    }
    const targetDir = path.join(resolvedBase, name.trim());
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
      await run(`chmod 2775 "${targetDir}" 2>/dev/null`).catch(() => {});
    }
    audit.logEvent('files', `Mappa létrehozva: ${targetDir}`, 'admin');
    res.json({ success: true, path: targetDir });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/folders/delete', async (req, res) => {
  try {
    const sambaBase = getSambaBase();
    const { folderPath } = req.query;
    if (!folderPath) return res.status(400).json({ error: 'folderPath megadása kötelező!' });
    const absPath = path.resolve(folderPath);
    if (!absPath.startsWith(sambaBase) || absPath === sambaBase) {
      return res.status(403).json({ error: 'Csak a Samba almappák törölhetők!' });
    }
    await run(`rm -rf "${absPath}" 2>&1`);
    audit.logEvent('files', `Mappa törölve: ${absPath}`, 'admin');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================
// NOTIFICATION SYSTEM API
// ============================
app.get('/api/notifications/config', (req, res) => {
  try {
    const cfg = loadNotifConfig();
    res.json({
      config: {
        ...cfg,
        smtp: {
          ...cfg.smtp,
          pass: cfg.smtp.pass ? '••••••••' : ''
        }
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/notifications/config', (req, res) => {
  try {
    const current = loadNotifConfig();
    const { discord, smtp, events } = req.body;

    const updated = {
      discord: {
        enabled: discord ? !!discord.enabled : current.discord.enabled,
        webhookUrl: discord ? (discord.webhookUrl || '').trim() : current.discord.webhookUrl
      },
      smtp: {
        enabled: smtp ? !!smtp.enabled : current.smtp.enabled,
        host: smtp ? (smtp.host || '').trim() : current.smtp.host,
        port: smtp ? (parseInt(smtp.port) || 587) : current.smtp.port,
        secure: smtp ? !!smtp.secure : current.smtp.secure,
        user: smtp ? (smtp.user || '').trim() : current.smtp.user,
        pass: (smtp && smtp.pass && smtp.pass !== '••••••••') ? smtp.pass : current.smtp.pass,
        fromEmail: smtp ? (smtp.fromEmail || '').trim() : current.smtp.fromEmail,
        toEmail: smtp ? (smtp.toEmail || '').trim() : current.smtp.toEmail
      },
      events: {
        userChanges: events ? !!events.userChanges : current.events.userChanges,
        shareChanges: events ? !!events.shareChanges : current.events.shareChanges,
        serviceAlerts: events ? !!events.serviceAlerts : current.events.serviceAlerts,
        storageAlerts: events ? !!events.storageAlerts : current.events.storageAlerts
      }
    };

    saveNotifConfig(updated);
    audit.logEvent('config', 'Értesítési beállítások frissítve', 'admin');
    res.json({ success: true, message: 'Értesítési beállítások elmentve!' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/notifications/test', async (req, res) => {
  try {
    const { type, discordUrl, smtpConfig } = req.body;
    const testTitle = '🔔 Teszt Értesítés';
    const testMessage = `Sikeres teszt értesítés a SambaHub rendszerből!\nIdőpont: ${new Date().toLocaleString('hu-HU')}`;

    if (type === 'discord') {
      const url = (discordUrl || '').trim() || loadNotifConfig().discord.webhookUrl;
      if (!url) return res.status(400).json({ error: 'Nincs megadva Discord Webhook URL!' });
      await sendDiscordWebhook(url, testTitle, testMessage, 0x10b981);
      return res.json({ success: true, message: 'Discord teszt üzenet elküldve!' });
    } else if (type === 'smtp') {
      const cfg = smtpConfig || loadNotifConfig().smtp;
      if (!cfg.host || !cfg.toEmail) return res.status(400).json({ error: 'Hiányzó SMTP host vagy fogadó e-mail!' });
      await sendSmtpEmail(cfg, testTitle, testMessage);
      return res.json({ success: true, message: 'SMTP teszt e-mail elküldve!' });
    } else {
      await notifyEvent('system', testTitle, testMessage, 0x10b981);
      return res.json({ success: true, message: 'Teszt értesítés elküldve a beállított csatornákra!' });
    }
  } catch (e) {
    res.status(400).json({ error: 'Értesítés küldési hiba: ' + e.message });
  }
});

// ============================
// 11. SNAPSHOTS
// ============================
app.get('/api/snapshots', async (req, res) => {
  try {
    const snapshots = await getSnapshots();
    const config = loadSnapshotConfig();
    res.json({ snapshots, config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/snapshots/config', (req, res) => {
  try {
    const config = loadSnapshotConfig();
    res.json({ config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/snapshots/config', (req, res) => {
  try {
    saveSnapshotConfig(req.body);
    audit.logEvent('config', 'Automata snapshot beállítások elmentve', 'admin');
    res.json({ success: true, message: 'Automata snapshot beállítások elmentve!' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/snapshots', async (req, res) => {
  try {
    const { name } = req.body;
    const result = await createSnapshot(name);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/snapshots/:id/restore', async (req, res) => {
  try {
    const result = await restoreSnapshot(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/snapshots/:id', async (req, res) => {
  try {
    const result = await deleteSnapshot(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================
// PRINTERS & PRINTING API
// ============================
app.get('/api/printers', async (req, res) => {
  try {
    const printerInfo = await getPrinters();
    const config = loadPrinterConfig();
    res.json({ ...printerInfo, config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/printers/config', async (req, res) => {
  try {
    savePrinterConfig(req.body);
    startFolderPrintWatcher();
    audit.logEvent('config', 'Nyomtató beállítások elmentve', 'admin');
    res.json({ success: true, message: 'Nyomtató beállítások elmentve!' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/printers/print', async (req, res) => {
  try {
    const { filePath, printerName } = req.body;
    if (!filePath) return res.status(400).json({ error: 'A fájl útvonala megadása kötelező!' });
    const result = await printFile(filePath, printerName);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/printers/scan', async (req, res) => {
  try {
    const found = await scanNetworkPrinters();
    res.json({ success: true, printers: found });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/printers/add-manual', async (req, res) => {
  try {
    const result = await addManualPrinter(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/printers/manual/:id', async (req, res) => {
  try {
    const result = await removeManualPrinter(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/printers/install-cups', async (req, res) => {
  try {
    const result = await installCupsPackages();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/printers/test-email', async (req, res) => {
  try {
    const result = await checkImapEmailAccount(req.body);
    res.json({ success: true, message: 'IMAP E-mail kapcsolat teszt sikeres!', details: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/printers/recent-emails', (req, res) => {
  try {
    const { getRecentEmailsLog } = require('./lib/printers');
    res.json({ emails: getRecentEmailsLog() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/printers/check-email-now', async (req, res) => {
  try {
    const { loadPrinterConfig, checkImapEmailAccount } = require('./lib/printers');
    const cfg = loadPrinterConfig();
    if (!cfg.emailPrint || !cfg.emailPrint.enabled) {
      return res.status(400).json({ error: 'Az e-mail nyomtatás funkció nincs bekapcsolva!' });
    }
    const result = await checkImapEmailAccount(cfg.emailPrint);
    res.json({ success: true, savedFilesCount: result.savedFilesCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================
// 12. SERVICE CONTROL
// ============================
app.post('/api/service/:action', async (req, res) => {
  const { action } = req.params;
  const validActions = ['start', 'stop', 'restart', 'enable', 'disable'];
  if (!validActions.includes(action)) {
    return res.status(400).json({ error: 'Érvénytelen művelet' });
  }

  try {
    await run(`systemctl ${action} smbd 2>&1`);
    if (['start', 'stop', 'restart'].includes(action)) {
      await run(`systemctl ${action} nmbd 2>&1`).catch(() => {});
    }
    const status = await run('systemctl is-active smbd 2>/dev/null || echo inactive');
    audit.logEvent('service', `Szolgáltatás művelet: ${action}`, 'admin', { action });
    res.json({ success: true, status: status.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================
// 13. SETTINGS & EXPORT/IMPORT
// ============================
app.get('/api/locales', (req, res) => {
  try {
    const localesDir = path.join(__dirname, 'public', 'locales');
    if (!fs.existsSync(localesDir)) {
      return res.json({ locales: [{ code: 'hu', name: 'Magyar' }, { code: 'en', name: 'English' }] });
    }
    const files = fs.readdirSync(localesDir);
    const locales = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        const code = file.replace('.json', '');
        try {
          const content = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
          locales.push({
            code,
            name: content.lang_name || code
          });
        } catch (e) {
          locales.push({ code, name: code });
        }
      }
    }
    res.json({ locales });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/settings', (req, res) => {
  res.json({ settings: getSettings() });
});

app.put('/api/settings', (req, res) => {
  try {
    const updated = saveSettings(req.body);
    res.json({ success: true, settings: updated });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});



app.get('/api/settings/export', async (req, res) => {
  try {
    const data = await exportFullConfig();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="nas-smb-config.json"');
    res.send(JSON.stringify(data, null, 2));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings/import', async (req, res) => {
  try {
    const result = await importFullConfig(req.body);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================
// 14. VERSION CONTROL & AUTO UPDATE
// ============================
app.get('/api/version/check', async (req, res) => {
  try {
    const versionInfo = await checkVersion();
    res.json(versionInfo);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/version/changelog', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const changelog = await getChangelog(limit);
    res.json({ changelog });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/version/releases', async (req, res) => {
  try {
    const releases = await getReleases();
    res.json({ releases });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/version/update', async (req, res) => {
  try {
    const result = await applySystemUpdate();
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// ============================
// START SERVER
// ============================
const pkg = require('./package.json');
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🚀 NAS SMB Manager v${pkg.version} running at http://localhost:${PORT}\n`);
});
