const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logEvent } = require('./audit');

const SMB_CONF = '/etc/samba/smb.conf';

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

// Parse smb.conf into list of shares
function getShares() {
  try {
    const content = fs.readFileSync(SMB_CONF, 'utf8');
    const shares = [];
    let current = null;

    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

      const secMatch = trimmed.match(/^\[(.+)\]$/);
      if (secMatch) {
        if (current) shares.push(current);
        current = { name: secMatch[1], settings: {} };
        continue;
      }

      if (current && trimmed.includes('=')) {
        const [key, ...rest] = trimmed.split('=');
        current.settings[key.trim()] = rest.join('=').trim();
      }
    }
    if (current) shares.push(current);

    // Filter out global section
    return shares.filter(s => s.name.toLowerCase() !== 'global').map(s => {
      const isPublic = s.settings['guest ok'] === 'yes' || s.settings['public'] === 'yes';
      const disabled = s.settings['available'] === 'no';
      const readOnly = s.settings['read only'] === 'yes';
      const recycle = (s.settings['vfs objects'] || '').includes('recycle');
      return {
        name: s.name,
        path: s.settings['path'] || '',
        comment: s.settings['comment'] || '',
        isPublic,
        disabled,
        readOnly,
        recycle,
        validUsers: s.settings['valid users'] || '',
        writeList: s.settings['write list'] || '',
        settings: s.settings
      };
    });
  } catch (e) {
    return [];
  }
}

// Create or update share in smb.conf
async function saveShare({ name, folderPath, comment, isPublic, readOnly, disabled, recycle, validUsers, writeList }, adminUser = 'admin') {
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
    throw new Error('Érvénytelen megosztás név!');
  }
  if (!folderPath) throw new Error('Mappa útvonal megadása kötelező!');

  // Ensure folder exists with proper permissions
  const absPath = path.resolve(folderPath);
  if (!fs.existsSync(absPath)) {
    fs.mkdirSync(absPath, { recursive: true });
  }
  if (isPublic) {
    await run(`chmod 0777 "${absPath}" 2>/dev/null`).catch(() => {});
  } else {
    await run(`chmod 2775 "${absPath}" 2>/dev/null`).catch(() => {});
  }

  let content = fs.readFileSync(SMB_CONF, 'utf8');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(SMB_CONF, `${SMB_CONF}.backup-${timestamp}`);

  // Remove existing section if editing
  const sections = content.split(/(?=^\[)/m);
  const filtered = sections.filter(sec => {
    const m = sec.trim().match(/^\[(.+)\]$/m);
    return !m || m[1].toLowerCase() !== name.toLowerCase();
  });

  let newShareConf = `\n[${name}]\n`;
  newShareConf += `   comment = ${comment || 'SMB Megosztás'}\n`;
  newShareConf += `   path = ${absPath}\n`;
  newShareConf += `   browseable = yes\n`;
  newShareConf += `   available = ${disabled ? 'no' : 'yes'}\n`;
  newShareConf += `   read only = ${readOnly ? 'yes' : 'no'}\n`;
  newShareConf += `   guest ok = ${isPublic ? 'yes' : 'no'}\n`;
  newShareConf += `   public = ${isPublic ? 'yes' : 'no'}\n`;
  if (!isPublic && validUsers && validUsers.trim()) {
    newShareConf += `   valid users = ${validUsers.trim()}\n`;
  }
  if (writeList && writeList.trim()) newShareConf += `   write list = ${writeList.trim()}\n`;
  
  if (recycle) {
    newShareConf += `   vfs objects = recycle\n`;
    newShareConf += `   recycle:repository = .recycle\n`;
    newShareConf += `   recycle:keeptree = yes\n`;
    newShareConf += `   recycle:versions = yes\n`;
  }
  newShareConf += `   create mask = 0664\n`;
  newShareConf += `   directory mask = 2775\n`;

  content = filtered.join('') + newShareConf;
  fs.writeFileSync(SMB_CONF, content, 'utf8');

  // Validate testparm
  try {
    await run('testparm -s 2>&1');
  } catch (e) {
    // restore backup on error
    fs.copyFileSync(`${SMB_CONF}.backup-${timestamp}`, SMB_CONF);
    throw new Error('Konfiguráció validáció sikertelen: ' + e.message);
  }

  // Reload samba
  await run('systemctl reload smbd 2>/dev/null || systemctl restart smbd 2>/dev/null').catch(() => {});

  logEvent('shares', `Megosztás mentve: [${name}]`, adminUser, { name, absPath, isPublic, readOnly, disabled, recycle });
  return { success: true, name };
}

// Toggle share enable/disable
async function toggleShare(shareName, enable, adminUser = 'admin') {
  let content = fs.readFileSync(SMB_CONF, 'utf8');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(SMB_CONF, `${SMB_CONF}.backup-${timestamp}`);

  const sections = content.split(/(?=^\[)/m);
  const updated = sections.map(sec => {
    const m = sec.trim().match(/^\[(.+)\]$/m);
    if (m && m[1].toLowerCase() === shareName.toLowerCase()) {
      if (sec.includes('available =')) {
        return sec.replace(/available\s*=\s*(yes|no)/i, `available = ${enable ? 'yes' : 'no'}`);
      } else {
        return sec + `   available = ${enable ? 'yes' : 'no'}\n`;
      }
    }
    return sec;
  });

  fs.writeFileSync(SMB_CONF, updated.join(''), 'utf8');
  await run('systemctl reload smbd 2>/dev/null').catch(() => {});
  logEvent('shares', `Megosztás ${enable ? 'engedélyezve' : 'tiltva'}: [${shareName}]`, adminUser, { shareName, enable });
  return { success: true };
}

// Delete share
async function deleteShare(shareName, adminUser = 'admin') {
  let content = fs.readFileSync(SMB_CONF, 'utf8');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(SMB_CONF, `${SMB_CONF}.backup-${timestamp}`);

  const sections = content.split(/(?=^\[)/m);
  const filtered = sections.filter(sec => {
    const m = sec.trim().match(/^\[(.+)\]$/m);
    return !m || m[1].toLowerCase() !== shareName.toLowerCase();
  });

  fs.writeFileSync(SMB_CONF, filtered.join(''), 'utf8');
  await run('systemctl reload smbd 2>/dev/null').catch(() => {});
  logEvent('shares', `Megosztás törölve: [${shareName}]`, adminUser, { shareName });
  return { success: true };
}

module.exports = { getShares, saveShare, toggleShare, deleteShare };
