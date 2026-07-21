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

  // 1. Read POSIX owner/group/mode via stat
  let statOwner = '', statGroup = '', statMode = '';
  try {
    const statOut = await run(`stat -c '%U %G %a' "${folderPath}"`);
    const parts = statOut.split(' ');
    statOwner = parts[0] || '';
    statGroup = parts[1] || '';
    statMode = parts[2] || '';
  } catch (e) {}

  // Parse octal mode to rwx levels for owner, group, other
  const ownerOctal = parseInt(statMode.charAt(statMode.length - 3) || '0', 10);
  const groupOctal = parseInt(statMode.charAt(statMode.length - 2) || '0', 10);
  const otherOctal = parseInt(statMode.charAt(statMode.length - 1) || '0', 10);

  function octalToLevel(o) {
    if (o >= 6) return 'full';   // rw or rwx
    if (o >= 4) return 'read';   // r or r-x
    return 'none';
  }

  const posixOwnerLevel = octalToLevel(ownerOctal);
  const posixGroupLevel = octalToLevel(groupOctal);
  const posixOtherLevel = octalToLevel(otherOctal);

  // 2. Read ACL entries from getfacl (named user:/group: entries)
  let aclOutput = '';
  try {
    aclOutput = await run(`getfacl -p "${folderPath}" 2>/dev/null`);
  } catch (e) {}

  const userPerms = {};
  const groupPerms = {};

  for (const line of aclOutput.split('\n')) {
    const trimmed = line.trim();
    // Named user ACL: user:username:rwx
    const uMatch = trimmed.match(/^user:([^:]+):([rwx-]+)/);
    if (uMatch && uMatch[1]) {
      userPerms[uMatch[1]] = uMatch[2];
    }
    // Named group ACL: group:groupname:rwx
    const gMatch = trimmed.match(/^group:([^:]+):([rwx-]+)/);
    if (gMatch && gMatch[1]) {
      groupPerms[gMatch[1]] = gMatch[2];
    }
  }

  // Helper: pick the higher access level
  function higherLevel(a, b) {
    const order = { none: 0, read: 1, full: 2 };
    return (order[a] || 0) >= (order[b] || 0) ? a : b;
  }
  function levelToPerms(lvl) {
    return lvl === 'full' ? 'rwx' : (lvl === 'read' ? 'r-x' : '---');
  }

  // 3. Build user permissions list - merge POSIX owner + ACL entries
  const userList = users.map(u => {
    let perms = userPerms[u.username] || '---';
    let level = permsToLevel(perms);

    // If this user is the POSIX owner, apply owner bits
    if (u.username === statOwner) {
      level = higherLevel(level, posixOwnerLevel);
    }
    perms = levelToPerms(level);

    return {
      name: u.username,
      fullName: u.fullName,
      type: 'user',
      perms,
      level,
      isOwner: u.username === statOwner
    };
  });

  // 4. Build group permissions list - merge POSIX group + ACL entries
  const groupList = groups.map(g => {
    let perms = groupPerms[g.name] || '---';
    let level = permsToLevel(perms);

    // If this group is the POSIX owning group, apply group bits
    if (g.name === statGroup) {
      level = higherLevel(level, posixGroupLevel);
    }
    perms = levelToPerms(level);

    return {
      name: g.name,
      type: 'group',
      perms,
      level,
      isOwnerGroup: g.name === statGroup
    };
  });

  return {
    path: folderPath,
    owner: statOwner,
    group: statGroup,
    mode: statMode,
    users: userList,
    groups: groupList
  };
}

function permsToLevel(perms) {
  if (!perms || perms === '---') return 'none';
  if (perms.includes('w')) return 'full';     // rwx or rw-
  if (perms.includes('r')) return 'read';     // r-x or r--
  return 'none';
}

// Save permissions for both users and groups
async function saveFolderPermissions(folderPath, { userPermissions = [], groupPermissions = [] }, adminUser = 'admin') {
  if (!fs.existsSync(folderPath)) throw new Error('A mappa nem létezik!');

  // Clear existing ACLs recursively
  await run(`setfacl -R -b "${folderPath}" 2>/dev/null`).catch(() => {});

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
