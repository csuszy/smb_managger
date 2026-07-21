const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logEvent } = require('./audit');
const { isUserAdmin, addOrUpdateAdminAccount, removeAdminAccount, loadConfig } = require('./auth');

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

function cleanUsername(username) {
  if (!username) throw new Error('Felhasználónév megadása kötelező!');
  let cleanUser = String(username).trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_.-]/g, '');
  if (!cleanUser) throw new Error('Érvénytelen felhasználónév!');
  return cleanUser;
}

// Get all Samba & System users with details
async function getUsers() {
  const users = [];
  try {
    const output = await run('pdbedit -L -v 2>/dev/null');
    let current = null;

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('---------------')) {
        if (current && current.username) users.push(current);
        current = {};
        continue;
      }
      if (!current) continue;

      if (trimmed.startsWith('Unix username:')) current.username = trimmed.split(':').slice(1).join(':').trim();
      else if (trimmed.startsWith('Full Name:')) current.fullName = trimmed.split(':').slice(1).join(':').trim();
      else if (trimmed.startsWith('Account Flags:')) current.flags = trimmed.split(':').slice(1).join(':').trim();
      else if (trimmed.startsWith('User SID:')) current.sid = trimmed.split(':').slice(1).join(':').trim();
      else if (trimmed.startsWith('Last logon:')) current.lastLogon = trimmed.split(':').slice(1).join(':').trim();
    }
    if (current && current.username) users.push(current);
  } catch (e) {}

  // Enhance each user with groups, disabled state & Web Admin role
  for (const u of users) {
    u.disabled = u.flags ? u.flags.includes('D') : false;
    u.isAdmin = isUserAdmin(u.username);
    u.groups = [];
    try {
      const groupsOut = await run(`groups ${u.username} 2>/dev/null`);
      if (groupsOut.includes(':')) {
        u.groups = groupsOut.split(':')[1].trim().split(/\s+/).filter(g => g && g !== u.username);
      }
    } catch (e) {}
  }

  return users;
}

// Create SMB user
async function createUser({ username, password, fullName, groups = [], isAdmin = false, role = 'user' }, adminUser = 'admin') {
  if (!username || !password) throw new Error('Felhasználónév és jelszó megadása kötelező!');

  const cleanUser = cleanUsername(username);
  const makeAdmin = isAdmin || role === 'admin';

  // Create linux system user if missing
  try {
    await run(`id ${cleanUser} 2>/dev/null`);
  } catch (e) {
    await run(`useradd -g users -N -M -s /sbin/nologin ${cleanUser} 2>&1`).catch(async () => {
      await run(`useradd -g users -M -s /sbin/nologin ${cleanUser} 2>&1`);
    });
  }

  await run(`usermod -g users ${cleanUser} 2>/dev/null`).catch(() => {});
  await run(`groupdel ${cleanUser} 2>/dev/null`).catch(() => {});

  // Create samba password
  try {
    await run(`printf '%s\\n%s\\n' '${password.replace(/'/g, "'\\''")}' '${password.replace(/'/g, "'\\''")}' | smbpasswd -a -s ${cleanUser} 2>&1`);
  } catch (e) {
    await run(`printf '%s\\n%s\\n' '${password.replace(/'/g, "'\\''")}' '${password.replace(/'/g, "'\\''")}' | smbpasswd -s ${cleanUser} 2>&1`);
  }

  if (fullName) {
    await run(`pdbedit -u ${cleanUser} --fullname="${fullName.replace(/"/g, '\\"')}" 2>&1`).catch(() => {});
  }

  // Handle Web Admin role creation
  if (makeAdmin) {
    addOrUpdateAdminAccount(cleanUser, password);
  }

  // Ensure user home directory exists directly inside /srv/samba/<cleanUser>
  const homesBase = loadConfig().storageBasePath || '/srv/samba';
  const userHome = path.join(homesBase, cleanUser);
  try {
    if (!fs.existsSync(userHome)) {
      fs.mkdirSync(userHome, { recursive: true });
    }
    await run(`chown -R ${cleanUser}:${cleanUser} "${userHome}" 2>/dev/null || chown -R ${cleanUser} "${userHome}" 2>/dev/null`).catch(() => {});
    await run(`setfacl -b "${userHome}" 2>/dev/null`).catch(() => {});
    await run(`chmod 0775 "${userHome}" 2>/dev/null`).catch(() => {});
  } catch (e) {
    console.error('Home directory setup error:', e);
  }

  logEvent('users', `Felhasználó létrehozva (${makeAdmin ? 'Adminisztrátor' : 'Samba Felhasználó'}): ${cleanUser}`, adminUser, { username: cleanUser, fullName, groups, isAdmin: makeAdmin });
  return { success: true, username: cleanUser };
}

// Update user details (fullName, groups, isAdmin)
async function updateUser(username, { fullName, groups, isAdmin }, adminUser = 'admin') {
  const cleanUser = cleanUsername(username);

  if (fullName !== undefined) {
    await run(`pdbedit -u ${cleanUser} --fullname="${fullName.replace(/"/g, '\\"')}" 2>&1`).catch(() => {});
  }

  if (isAdmin === false) {
    removeAdminAccount(cleanUser);
  }

  if (Array.isArray(groups)) {
    let currentGroups = [];
    try {
      const gOut = await run(`groups ${cleanUser} 2>/dev/null`);
      if (gOut.includes(':')) currentGroups = gOut.split(':')[1].trim().split(/\s+/);
    } catch (e) {}

    for (const g of groups) {
      if (!currentGroups.includes(g)) {
        await run(`gpasswd -a ${cleanUser} ${g} 2>/dev/null`).catch(() => {});
      }
    }
    for (const g of currentGroups) {
      if (g !== cleanUser && !groups.includes(g)) {
        await run(`gpasswd -d ${cleanUser} ${g} 2>/dev/null`).catch(() => {});
      }
    }
  }

  logEvent('users', `Felhasználó módosítva: ${cleanUser}`, adminUser, { username: cleanUser, fullName, groups, isAdmin });
  return { success: true };
}

// Change password
async function changePassword(username, password, adminUser = 'admin') {
  const cleanUser = cleanUsername(username);
  if (!password) throw new Error('Password required');
  await run(`printf '%s\\n%s\\n' '${password.replace(/'/g, "'\\''")}' '${password.replace(/'/g, "'\\''")}' | smbpasswd -s ${cleanUser} 2>&1`);

  if (isUserAdmin(cleanUser)) {
    addOrUpdateAdminAccount(cleanUser, password);
  }

  logEvent('users', `Jelszó módosítva: ${cleanUser}`, adminUser, { username: cleanUser });
  return { success: true };
}

// Toggle user enable/disable
async function toggleUser(username, enable, adminUser = 'admin') {
  const cleanUser = cleanUsername(username);
  const flag = enable ? '-e' : '-d';
  await run(`smbpasswd ${flag} ${cleanUser} 2>&1`);
  logEvent('users', `Felhasználó ${enable ? 'engedélyezve' : 'tiltva'}: ${cleanUser}`, adminUser, { username: cleanUser, enable });
  return { success: true };
}

// Delete user
async function deleteUser(username, adminUser = 'admin') {
  const cleanUser = cleanUsername(username);
  await run(`smbpasswd -x ${cleanUser} 2>&1`).catch(() => {});
  await run(`userdel ${cleanUser} 2>&1`).catch(() => {});
  removeAdminAccount(cleanUser);

  logEvent('users', `Felhasználó törölve: ${cleanUser}`, adminUser, { username: cleanUser });
  return { success: true };
}

module.exports = { getUsers, createUser, updateUser, changePassword, toggleUser, deleteUser };
