const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getShares } = require('./shares');
const { logEvent } = require('./audit');

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

// Find all files in .recycle folders across active shares
async function getRecycleFiles() {
  const shares = getShares();
  const recycleFiles = [];

  for (const s of shares) {
    if (!s.path || !fs.existsSync(s.path)) continue;
    const recycleDir = path.join(s.path, '.recycle');
    if (!fs.existsSync(recycleDir)) continue;

    try {
      const walk = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relPath = path.relative(recycleDir, fullPath);
          const stat = fs.statSync(fullPath);

          if (entry.isDirectory()) {
            walk(fullPath);
          } else {
            const originalPath = path.join(s.path, relPath);
            recycleFiles.push({
              id: Buffer.from(fullPath).toString('base64'),
              name: entry.name,
              share: s.name,
              recyclePath: fullPath,
              originalPath,
              size: stat.size,
              deletedAt: stat.mtime
            });
          }
        }
      };
      walk(recycleDir);
    } catch (e) {}
  }

  return recycleFiles;
}

// Restore file from recycle bin
async function restoreRecycleFile(fileId, adminUser = 'admin') {
  const recycleFiles = await getRecycleFiles();
  const target = recycleFiles.find(f => f.id === fileId);
  if (!target) throw new Error('Fájl nem található a lomtárban');

  const origDir = path.dirname(target.originalPath);
  if (!fs.existsSync(origDir)) fs.mkdirSync(origDir, { recursive: true });

  fs.renameSync(target.recyclePath, target.originalPath);
  logEvent('files', `Lomtár fájl visszaállítva: ${target.name}`, adminUser, { originalPath: target.originalPath });
  return { success: true, path: target.originalPath };
}

// Bulk restore
async function restoreRecycleFiles(fileIds = [], adminUser = 'admin') {
  let count = 0;
  for (const id of fileIds) {
    try {
      await restoreRecycleFile(id, adminUser);
      count++;
    } catch (e) {}
  }
  return { success: true, count };
}

// Delete permanently from recycle bin
async function deleteRecycleFile(fileId, adminUser = 'admin') {
  const recycleFiles = await getRecycleFiles();
  const target = recycleFiles.find(f => f.id === fileId);
  if (!target) throw new Error('Fájl nem található a lomtárban');

  fs.unlinkSync(target.recyclePath);
  logEvent('files', `Lomtár fájl véglegesen törölve: ${target.name}`, adminUser, { recyclePath: target.recyclePath });
  return { success: true };
}

// Bulk delete
async function deleteRecycleFiles(fileIds = [], adminUser = 'admin') {
  let count = 0;
  for (const id of fileIds) {
    try {
      await deleteRecycleFile(id, adminUser);
      count++;
    } catch (e) {}
  }
  return { success: true, count };
}

// Empty entire recycle bin
async function emptyRecycleBin(adminUser = 'admin') {
  const shares = getShares();
  let count = 0;
  for (const s of shares) {
    if (!s.path) continue;
    const recycleDir = path.join(s.path, '.recycle');
    if (fs.existsSync(recycleDir)) {
      await run(`rm -rf "${recycleDir}"/* 2>/dev/null`).catch(() => {});
      count++;
    }
  }
  logEvent('files', 'Lomtár teljesen kiürítve', adminUser, { sharesAffected: count });
  return { success: true };
}

module.exports = {
  getRecycleFiles,
  restoreRecycleFile,
  restoreRecycleFiles,
  deleteRecycleFile,
  deleteRecycleFiles,
  emptyRecycleBin
};
