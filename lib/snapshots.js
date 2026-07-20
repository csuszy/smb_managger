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
  const snapPath = path.join(SNAPSHOT_BASE, snapId);
  if (!fs.existsSync(snapPath)) throw new Error('Snapshot nem található!');

  // Rsync back to /srv/samba
  await run(`rsync -a --delete --exclude='.snapshots' "${snapPath}/" /srv/samba/ 2>&1`);

  logEvent('files', `Snapshot visszaállítva: ${snapId}`, adminUser, { snapId, snapPath });
  return { success: true, snapId };
}

// Delete snapshot
async function deleteSnapshot(snapId, adminUser = 'admin') {
  const snapPath = path.join(SNAPSHOT_BASE, snapId);
  if (!fs.existsSync(snapPath)) throw new Error('Snapshot nem található!');

  try {
    await run(`btrfs subvolume delete "${snapPath}" 2>/dev/null`);
  } catch (e) {
    await run(`rm -rf "${snapPath}" 2>&1`);
  }

  logEvent('files', `Snapshot törölve: ${snapId}`, adminUser, { snapId });
  return { success: true };
}

module.exports = { getSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot };
