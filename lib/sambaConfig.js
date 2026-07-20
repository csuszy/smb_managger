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

// Get global GUI config options
function getSambaGlobalConfig() {
  try {
    const content = fs.readFileSync(SMB_CONF, 'utf8');
    const globalSettings = {
      workgroup: 'WORKGROUP',
      netbiosName: 'NAS-SERVER',
      serverString: 'NAS Samba Server',
      security: 'user',
      serverMinProtocol: 'SMB2_10',
      serverMaxProtocol: 'SMB3_11',
      guestOk: 'yes',
      smbEncrypt: 'auto',
      logLevel: '1',
      vfsRecycleGlobal: false
    };

    const lines = content.split('\n');
    let inGlobal = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
      const m = trimmed.match(/^\[(.+)\]$/);
      if (m) {
        inGlobal = (m[1].toLowerCase() === 'global');
        continue;
      }
      if (inGlobal && trimmed.includes('=')) {
        const [key, ...rest] = trimmed.split('=');
        const k = key.trim().toLowerCase();
        const v = rest.join('=').trim();

        if (k === 'workgroup') globalSettings.workgroup = v;
        else if (k === 'netbios name') globalSettings.netbiosName = v;
        else if (k === 'server string') globalSettings.serverString = v;
        else if (k === 'security') globalSettings.security = v;
        else if (k === 'server min protocol' || k === 'min protocol') globalSettings.serverMinProtocol = v;
        else if (k === 'server max protocol' || k === 'max protocol') globalSettings.serverMaxProtocol = v;
        else if (k === 'map to guest' || k === 'guest ok') globalSettings.guestOk = (v === 'Bad User' || v === 'yes') ? 'yes' : 'no';
        else if (k === 'smb encrypt') globalSettings.smbEncrypt = v;
        else if (k === 'log level') globalSettings.logLevel = v;
        else if (k === 'vfs objects' && v.includes('recycle')) globalSettings.vfsRecycleGlobal = true;
      }
    }

    return globalSettings;
  } catch (e) {
    return {};
  }
}

// Save global GUI config options to smb.conf
async function saveSambaGlobalConfig(settings, adminUser = 'admin') {
  let content = fs.readFileSync(SMB_CONF, 'utf8');

  // Backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(SMB_CONF, `${SMB_CONF}.backup-${timestamp}`);

  const sections = content.split(/(?=^\[)/m);
  let globalIndex = -1;

  for (let i = 0; i < sections.length; i++) {
    if (sections[i].trim().match(/^\[global\]/i)) {
      globalIndex = i;
      break;
    }
  }

  // Build new [global] section
  let globalConf = `[global]\n`;
  globalConf += `   workgroup = ${settings.workgroup || 'WORKGROUP'}\n`;
  if (settings.netbiosName && settings.netbiosName.trim()) {
    globalConf += `   netbios name = ${settings.netbiosName.trim().toUpperCase()}\n`;
  }
  globalConf += `   server string = ${settings.serverString || 'NAS Samba Server'}\n`;
  globalConf += `   security = ${settings.security || 'user'}\n`;
  globalConf += `   server min protocol = ${settings.serverMinProtocol || 'SMB2_10'}\n`;
  globalConf += `   server max protocol = ${settings.serverMaxProtocol || 'SMB3_11'}\n`;
  globalConf += `   map to guest = ${settings.guestOk === 'yes' ? 'Bad User' : 'Never'}\n`;
  globalConf += `   smb encrypt = ${settings.smbEncrypt || 'auto'}\n`;
  globalConf += `   log level = ${settings.logLevel || '1'}\n`;
  globalConf += `   log file = /var/log/samba/log.%m\n`;
  globalConf += `   max log size = 1000\n`;
  if (settings.vfsRecycleGlobal) {
    globalConf += `   vfs objects = recycle\n`;
    globalConf += `   recycle:repository = .recycle\n`;
    globalConf += `   recycle:keeptree = yes\n`;
  }
  globalConf += `\n`;

  const otherSections = sections.filter(sec => {
    const trimmed = sec.trim();
    return !trimmed.match(/^\[global\]/i) && !trimmed.startsWith('# Sample configuration');
  });

  content = globalConf + otherSections.join('');
  fs.writeFileSync(SMB_CONF, content, 'utf8');

  // Validate testparm
  try {
    await run('testparm -s 2>&1');
  } catch (e) {
    fs.copyFileSync(`${SMB_CONF}.backup-${timestamp}`, SMB_CONF);
    throw new Error('Konfiguráció érvénytelen: ' + e.message);
  }

  await run('systemctl reload smbd 2>/dev/null || systemctl restart smbd 2>/dev/null').catch(() => {});

  logEvent('config', 'Samba globális konfiguráció frissítve (GUI)', adminUser, settings);
  return { success: true, settings };
}

// Ensure [homes] section exists in smb.conf with path = /srv/samba/%S
async function ensureDefaultHomesSection(targetBase = '/srv/samba') {
  const homesBase = path.resolve(targetBase);
  try {
    if (!fs.existsSync(homesBase)) {
      fs.mkdirSync(homesBase, { recursive: true });
    }
    await run(`chmod 0755 "${homesBase}" 2>/dev/null`).catch(() => {});

    let content = fs.readFileSync(SMB_CONF, 'utf8');
    
    // Remove any previous [homes] section
    const sections = content.split(/(?=^\[)/m);
    const filtered = sections.filter(sec => !sec.trim().startsWith('[homes]') && !sec.trim().startsWith('# HOME_DIR='));
    
    const homesConf = `\n# HOME_DIR=${homesBase}\n[homes]\n   comment = Felhasználói Saját Mappák (Home Directories)\n   path = ${homesBase}/%S\n   browseable = no\n   read only = no\n   create mask = 0775\n   directory mask = 0775\n   valid users = %S\n   writable = yes\n`;

    content = filtered.join('') + homesConf;
    fs.writeFileSync(SMB_CONF, content, 'utf8');
    await run('systemctl reload smbd 2>/dev/null || systemctl restart smbd 2>/dev/null').catch(() => {});

    // Fix permissions and remove broken ACL masks for all existing Samba users directly in /srv/samba/<username>
    const usersOut = await run('pdbedit -L 2>/dev/null').catch(() => '');
    const usernames = usersOut.split('\n').filter(l => l.trim()).map(l => l.split(':')[0]);
    for (const u of usernames) {
      const uDir = path.join(homesBase, u);
      if (!fs.existsSync(uDir)) {
        fs.mkdirSync(uDir, { recursive: true });
      }
      await run(`chown -R ${u}:${u} "${uDir}" 2>/dev/null || chown -R ${u} "${uDir}" 2>/dev/null`).catch(() => {});
      await run(`setfacl -b "${uDir}" 2>/dev/null`).catch(() => {});
      await run(`chmod 0775 "${uDir}" 2>/dev/null`).catch(() => {});
    }
  } catch (e) {
    console.error('ensureDefaultHomesSection error:', e);
  }
}

module.exports = { getSambaGlobalConfig, saveSambaGlobalConfig, ensureDefaultHomesSection };
