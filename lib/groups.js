const { exec } = require('child_process');
const fs = require('fs');
const { logEvent } = require('./audit');

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

// Get system groups (filtering out personal user groups, keeping shared functional groups)
async function getGroups() {
  const groups = [];
  try {
    // Collect all usernames to exclude private user groups
    const passwdContent = fs.readFileSync('/etc/passwd', 'utf8');
    const systemUsernames = new Set();
    for (const l of passwdContent.split('\n')) {
      const parts = l.split(':');
      if (parts[0]) systemUsernames.add(parts[0].trim());
    }

    const groupFile = fs.readFileSync('/etc/group', 'utf8');
    for (const line of groupFile.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [name, passwd, gid, membersStr] = trimmed.split(':');
      const gidNum = parseInt(gid);

      // Do NOT list individual personal user groups (groups matching a username unless it's 'users')
      if (systemUsernames.has(name) && name !== 'users') continue;

      // Include non-system groups (GID >= 1000) or samba/admin/users groups
      if (gidNum >= 1000 || ['samba', 'smb', 'users', 'admin'].includes(name)) {
        const members = membersStr ? membersStr.split(',').filter(m => m) : [];
        groups.push({ name, gid: gidNum, members });
      }
    }
  } catch (e) {}
  return groups;
}

function validateIdentifier(str, label = 'Név') {
  if (!str || !/^[a-zA-Z0-9_.-]+$/.test(str)) {
    throw new Error(`Érvénytelen ${label}!`);
  }
}

// Create new group
async function createGroup(groupName, adminUser = 'admin') {
  validateIdentifier(groupName, 'csoportnév');
  await run(`groupadd ${groupName} 2>&1`);
  logEvent('groups', `Csoport létrehozva: ${groupName}`, adminUser, { groupName });
  return { success: true, groupName };
}

// Delete group
async function deleteGroup(groupName, adminUser = 'admin') {
  validateIdentifier(groupName, 'csoportnév');
  await run(`groupdel ${groupName} 2>&1`);
  logEvent('groups', `Csoport törölve: ${groupName}`, adminUser, { groupName });
  return { success: true };
}

// Add user to group
async function addUserToGroup(username, groupName, adminUser = 'admin') {
  validateIdentifier(username, 'felhasználónév');
  validateIdentifier(groupName, 'csoportnév');
  await run(`gpasswd -a ${username} ${groupName} 2>&1`);
  logEvent('groups', `Felhasználó (${username}) hozzáadva a csoportoz: ${groupName}`, adminUser, { username, groupName });
  return { success: true };
}

// Remove user from group
async function removeUserFromGroup(username, groupName, adminUser = 'admin') {
  validateIdentifier(username, 'felhasználónév');
  validateIdentifier(groupName, 'csoportnév');
  await run(`gpasswd -d ${username} ${groupName} 2>&1`);
  logEvent('groups', `Felhasználó (${username}) eltávolítva a csoportból: ${groupName}`, adminUser, { username, groupName });
  return { success: true };
}

module.exports = { getGroups, createGroup, deleteGroup, addUserToGroup, removeUserFromGroup };
