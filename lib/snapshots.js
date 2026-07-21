const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logEvent } = require('./audit');

const SNAPSHOT_BASE = '/srv/samba/.snapshots';

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

// Ensure snapshot base dir
function initSnapshots() {
  if (!fs.existsSync(SNAPSHOT_BASE)) {
    fs.mkdirSync(SNAPSHOT_BASE, { recursive: true });
  }
}

initSnapshots();

const SNAPSHOT_CONFIG_FILE = path.join(__dirname, '../data/snapshot_config.json');

function loadSnapshotConfig() {
  try {
    if (fs.existsSync(SNAPSHOT_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
    enabled: false,
    intervalHours: 24, // 1h, 6h, 12h, 24h, 168h (weekly)
    maxSnapshots: 10
  };
}

function saveSnapshotConfig(cfg) {
  const dir = path.dirname(SNAPSHOT_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SNAPSHOT_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  initSnapshotWatcher();
}

let snapshotTimer = null;

function initSnapshotWatcher() {
  if (snapshotTimer) clearInterval(snapshotTimer);
  const cfg = loadSnapshotConfig();
  if (!cfg.enabled) return;

  const intervalMs = (cfg.intervalHours || 24) * 3600 * 1000;
  snapshotTimer = setInterval(async () => {
    try {
      const snapName = 'autosnap_' + new Date().toISOString().replace(/[:.]/g, '-');
      await createSnapshot(snapName, 'system-auto');

      // Auto cleanup old snapshots exceeding maxSnapshots
      const snapshots = await getSnapshots();
      const autoSnaps = snapshots.filter(s => s.name.startsWith('autosnap_'));
      if (autoSnaps.length > (cfg.maxSnapshots || 10)) {
        const toDelete = autoSnaps.slice(cfg.maxSnapshots || 10);
        for (const s of toDelete) {
          await deleteSnapshot(s.id, 'system-auto').catch(() => {});
        }
      }
    } catch (e) {
      console.error('Automated snapshot error:', e.message);
    }
  }, intervalMs);
}

// Start watcher
initSnapshotWatcher();

// Get list of snapshots
async function getSnapshots() {
  initSnapshots();
  const snapshots = [];

  // Check if system uses BTRFS / ZFS
  let isBtrfs = false;
  try {
    const bOut = await run('btrfs subvolume list /srv/samba 2>/dev/null');
    if (bOut) isBtrfs = true;
  } catch (e) {}

  if (fs.existsSync(SNAPSHOT_BASE)) {
    const entries = fs.readdirSync(SNAPSHOT_BASE, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const snapPath = path.join(SNAPSHOT_BASE, entry.name);
        const stat = fs.statSync(snapPath);
        
        // Calculate snapshot size
        let size = '0 B';
        try {
          const du = await run(`du -sh "${snapPath}" 2>/dev/null`);
          size = du.split(/\s+/)[0] || '0 B';
        } catch (e) {}

        snapshots.push({
          id: entry.name,
          name: entry.name,
          path: snapPath,
          created: stat.birthtime,
          size,
          isBtrfs
        });
      }
    }
  }

  return snapshots.sort((a, b) => b.created - a.created);
}

// Create new snapshot
async function createSnapshot(name, adminUser = 'admin') {
  initSnapshots();
  const snapName = name ? name.replace(/[^a-zA-Z0-9_-]/g, '_') : 'snap_' + new Date().toISOString().replace(/[:.]/g, '-');
  const snapPath = path.join(SNAPSHOT_BASE, snapName);

  if (fs.existsSync(snapPath)) throw new Error('Ilyen nevű snapshot már létezik!');

  // Try BTRFS subvolume snapshot first
  try {
    await run(`btrfs subvolume snapshot /srv/samba "${snapPath}" 2>/dev/null`);
  } catch (e) {
    // Fallback to rsync / cp -al (hardlink / fast copy snapshot)
    await run(`cp -al /srv/samba "${snapPath}" 2>/dev/null || rsync -a --exclude='.snapshots' /srv/samba/ "${snapPath}/" 2>&1`);
  }

  logEvent('files', `Snapshot létrehozva: ${snapName}`, adminUser, { snapName, snapPath });
  return { success: true, name: snapName, path: snapPath };
}

// Restore snapshot
async function restoreSnapshot(snapId, adminUser = 'admin') {
  const cleanId = path.basename(snapId);
  const snapPath = path.join(SNAPSHOT_BASE, cleanId);
  if (!fs.existsSync(snapPath)) throw new Error('Snapshot nem található!');

  // Rsync back to /srv/samba
  await run(`rsync -a --delete --exclude='.snapshots' "${snapPath}/" /srv/samba/ 2>&1`);

  logEvent('files', `Snapshot visszaállítva: ${cleanId}`, adminUser, { snapId: cleanId, snapPath });
  return { success: true, snapId: cleanId };
}

// Delete snapshot
async function deleteSnapshot(snapId, adminUser = 'admin') {
  const cleanId = path.basename(snapId);
  const snapPath = path.join(SNAPSHOT_BASE, cleanId);
  if (!fs.existsSync(snapPath)) throw new Error('Snapshot nem található!');

  try {
    await run(`btrfs subvolume delete "${snapPath}" 2>/dev/null`);
  } catch (e) {
    await run(`rm -rf "${snapPath}" 2>&1`);
  }

  logEvent('files', `Snapshot törölve: ${cleanId}`, adminUser, { snapId: cleanId });
  return { success: true };
}

module.exports = {
  getSnapshots,
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  loadSnapshotConfig,
  saveSnapshotConfig
};
