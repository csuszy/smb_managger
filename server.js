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
const { getSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot } = require('./lib/snapshots');
const { getSambaGlobalConfig, saveSambaGlobalConfig, ensureDefaultHomesSection } = require('./lib/sambaConfig');
const { getSettings, saveSettings, exportFullConfig, importFullConfig } = require('./lib/settings');
const audit = require('./lib/audit');

const app = express();
const PORT = 8080;
const SAMBA_BASE = '/srv/samba';

if (!fs.existsSync(SAMBA_BASE)) {
  fs.mkdirSync(SAMBA_BASE, { recursive: true });
}

// Guarantee default [homes] section and permissions
ensureDefaultHomesSection().catch(e => console.error(e));

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

// Helper logger

// ============================
// 1. DASHBOARD
// ============================
app.get('/api/dashboard', async (req, res) => {
  try {
    const sysInfo = await getSystemInfo();
    const storageInfo = await getStorageInfo(SAMBA_BASE);
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
      await setUserQuota(req.body.username, req.body.quotaMB);
    }
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
    const storage = await getStorageInfo(SAMBA_BASE);
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
    let reqPath = req.query.path ? path.resolve(req.query.path) : SAMBA_BASE;
    if (!fs.existsSync(reqPath)) {
      reqPath = SAMBA_BASE;
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

    const parentPath = reqPath !== '/' ? path.dirname(reqPath) : null;
    res.json({ currentPath: reqPath, parentPath, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/folders/create', async (req, res) => {
  try {
    const { basePath, name } = req.body;
    if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name.trim())) {
      return res.status(400).json({ error: 'Érvénytelen mappanév!' });
    }
    const targetDir = path.join(path.resolve(basePath || SAMBA_BASE), name.trim());
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
    const { folderPath } = req.query;
    if (!folderPath) return res.status(400).json({ error: 'folderPath megadása kötelező!' });
    const absPath = path.resolve(folderPath);
    if (!absPath.startsWith(SAMBA_BASE) && !absPath.startsWith('/srv/samba')) {
      return res.status(403).json({ error: 'Csak a Samba mappák törölhetők!' });
    }
    await run(`rm -rf "${absPath}" 2>&1`);
    audit.logEvent('files', `Mappa törölve: ${absPath}`, 'admin');
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================
// 11. SNAPSHOTS
// ============================
app.get('/api/snapshots', async (req, res) => {
  try {
    const snapshots = await getSnapshots();
    res.json({ snapshots });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
// START SERVER
// ============================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🚀 NAS SMB Manager v2.0 running at http://localhost:${PORT}\n`);
});
