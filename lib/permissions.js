const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getUsers } = require('./users');
const { getGroups } = require('./groups');
const { logEvent } = require('./audit');

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

// Get combined user and group permissions for a folder
async function getFolderPermissions(folderPath) {
  if (!fs.existsSync(folderPath)) throw new Error('A mappa nem létezik!');

  const users = await getUsers();
  const groups = await getGroups();

  let aclOutput = '';
  try {
    aclOutput = await run(`getfacl -p "${folderPath}" 2>/dev/null`);
  } catch (e) {}

  const userPerms = {};
  const groupPerms = {};

  for (const line of aclOutput.split('\n')) {
    const trimmed = line.trim();
    const uMatch = trimmed.match(/^user:([^:]+):([rwx-]+)/);
    if (uMatch && uMatch[1]) {
      userPerms[uMatch[1]] = uMatch[2];
    }
    const gMatch = trimmed.match(/^group:([^:]+):([rwx-]+)/);
    if (gMatch && gMatch[1]) {
      groupPerms[gMatch[1]] = gMatch[2];
    }
  }

  const userList = users.map(u => ({
    name: u.username,
    fullName: u.fullName,
    type: 'user',
    perms: userPerms[u.username] || '---',
    level: permsToLevel(userPerms[u.username])
  }));

  const groupList = groups.map(g => ({
    name: g.name,
    type: 'group',
    perms: groupPerms[g.name] || '---',
    level: permsToLevel(groupPerms[g.name])
  }));

  return { path: folderPath, users: userList, groups: groupList };
}

function permsToLevel(perms) {
  if (!perms || perms === '---') return 'none';
  if (perms === 'r-x' || perms === 'r--') return 'read';
  if (perms === 'rw-' || perms === 'rwx') return 'full';
  return 'read';
}

// Save permissions for both users and groups
async function saveFolderPermissions(folderPath, { userPermissions = [], groupPermissions = [] }, adminUser = 'admin') {
  if (!fs.existsSync(folderPath)) throw new Error('A mappa nem létezik!');

  // Clear existing ACLs
  await run(`setfacl -b "${folderPath}" 2>/dev/null`).catch(() => {});

  const isValidName = (n) => /^[a-zA-Z0-9_.-]+$/.test(n);

  // Apply User ACLs
  for (const item of userPermissions) {
    if (item.name && isValidName(item.name) && item.perms && item.perms !== '---' && item.perms !== 'none') {
      const p = item.perms === 'read' ? 'r-x' : 'rwx';
      await run(`setfacl -R -m u:${item.name}:${p} "${folderPath}" 2>&1`).catch(() => {});
      await run(`setfacl -R -m d:u:${item.name}:${p} "${folderPath}" 2>&1`).catch(() => {});
    }
  }

  // Apply Group ACLs
  for (const item of groupPermissions) {
    if (item.name && isValidName(item.name) && item.perms && item.perms !== '---' && item.perms !== 'none') {
      const p = item.perms === 'read' ? 'r-x' : 'rwx';
      await run(`setfacl -R -m g:${item.name}:${p} "${folderPath}" 2>&1`).catch(() => {});
      await run(`setfacl -R -m d:g:${item.name}:${p} "${folderPath}" 2>&1`).catch(() => {});
    }
  }

  logEvent('permissions', `Jogosultságok módosítva a mappához: ${folderPath}`, adminUser, { folderPath, userPermissions, groupPermissions });
  return { success: true };
}

module.exports = { getFolderPermissions, saveFolderPermissions };
