const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { logEvent } = require('./audit');

const SMB_CONF = '/etc/samba/smb.conf';
const AVAHI_DIR = '/etc/avahi/services';
const AVAHI_SERVICE_FILE = path.join(AVAHI_DIR, 'timemachine.service');

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getPrimaryLanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    if (name.startsWith('docker') || name.startsWith('br-') || name.startsWith('veth') || name.startsWith('virbr') || name.startsWith('cni')) continue;
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && net.address !== '127.0.0.1') {
        const isPhysical = /^(eth|en|wlan|wl|bond)/i.test(name);
        candidates.push({ name, address: net.address, priority: isPhysical ? 10 : 1 });
      }
    }
  }
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
}

/**
 * Synchronize Avahi (Bonjour / mDNS) service definition for Apple Time Machine discovery.
 * Advertises _smb._tcp and _adisk._tcp with adVN records matching all active Time Machine shares.
 */
async function syncAvahiTimeMachineService() {
  try {
    const { getShares } = require('./shares');
    const allShares = getShares();
    const tmShares = allShares.filter(s => !s.disabled && s.timeMachine);

    if (!fs.existsSync(AVAHI_DIR)) {
      try { fs.mkdirSync(AVAHI_DIR, { recursive: true }); } catch (e) {}
    }

    if (tmShares.length === 0) {
      // If no active Time Machine shares, generate generic SMB announcement without adisk
      const genericXml = `<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">%h (SambaHub)</name>
  <service>
    <type>_smb._tcp</type>
    <port>445</port>
  </service>
  <service>
    <type>_device-info._tcp</type>
    <port>0</port>
    <txt-record>model=RackMac</txt-record>
  </service>
</service-group>
`;
      fs.writeFileSync(AVAHI_SERVICE_FILE, genericXml, 'utf8');
    } else {
      // Build Time Machine Bonjour service with Apple adisk descriptors
      const adiskRecords = ['<txt-record>sys=waMa=0,adVF=0x100</txt-record>'];
      tmShares.forEach((share, index) => {
        // adVF=0x82 marks share specifically as an Apple Time Machine target
        const safeName = share.name.replace(/[<>&"]/g, '');
        adiskRecords.push(`<txt-record>dk${index}=adVN=${safeName},adVF=0x82</txt-record>`);
      });

      const tmXml = `<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">%h (Time Machine)</name>
  <service>
    <type>_smb._tcp</type>
    <port>445</port>
  </service>
  <service>
    <type>_adisk._tcp</type>
    <port>9</port>
    ${adiskRecords.join('\n    ')}
  </service>
  <service>
    <type>_device-info._tcp</type>
    <port>0</port>
    <txt-record>model=TimeCapsule8,119</txt-record>
  </service>
</service-group>
`;
      fs.writeFileSync(AVAHI_SERVICE_FILE, tmXml, 'utf8');
    }

    // Reload Avahi daemon to announce changes on LAN
    await run('systemctl reload avahi-daemon 2>/dev/null || systemctl restart avahi-daemon 2>/dev/null || true').catch(() => {});
    return { success: true, count: tmShares.length };
  } catch (err) {
    console.error('[TimeMachine] Failed to synchronize Avahi service:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Scan a directory for macOS Time Machine sparsebundles / backup bundles.
 */
async function scanFolderForBundles(folderPath, shareName) {
  const bundles = [];
  if (!folderPath || !fs.existsSync(folderPath)) return bundles;

  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      const isBundle = entry.name.endsWith('.sparsebundle') || entry.name.endsWith('.backupbundle');
      if (isBundle && entry.isDirectory()) {
        const bundlePath = path.join(folderPath, entry.name);
        let sizeBytes = 0;
        let sizeFormatted = '0 B';
        let bandCount = 0;
        let lastModified = null;
        let isLocked = false;

        try {
          const stat = fs.statSync(bundlePath);
          lastModified = stat.mtime;

          // Check for token / lock files
          const tokenPath = path.join(bundlePath, 'token');
          const lockPath = path.join(bundlePath, '.lock');
          const recoveryToken = path.join(bundlePath, '.RecoveryToken');
          if (fs.existsSync(tokenPath) || fs.existsSync(lockPath) || fs.existsSync(recoveryToken)) {
            isLocked = true;
          }

          // Count bands and calculate size
          const bandsDir = path.join(bundlePath, 'bands');
          if (fs.existsSync(bandsDir)) {
            try {
              const bandFiles = fs.readdirSync(bandsDir);
              bandCount = bandFiles.length;
            } catch (e) {}
          }

          try {
            const duOut = await run(`du -sb "${bundlePath}" 2>/dev/null || du -sh "${bundlePath}" 2>/dev/null`);
            const p = duOut.split(/\s+/);
            sizeBytes = parseInt(p[0]) || 0;
            sizeFormatted = formatBytes(sizeBytes);
          } catch (e) {}
        } catch (e) {}

        // Format Mac name
        let macName = entry.name.replace(/\.(sparsebundle|backupbundle)$/i, '');
        macName = macName.replace(/_/g, ' ');

        bundles.push({
          name: entry.name,
          macName,
          shareName,
          path: bundlePath,
          sizeBytes,
          sizeFormatted,
          bandCount,
          isLocked,
          lastModified: lastModified ? lastModified.toISOString() : null
        });
      }
    }
  } catch (e) {}

  return bundles;
}

/**
 * Get comprehensive Apple Time Machine status, shares, detected backups, and system health.
 */
async function getTimeMachineStatus() {
  const { getShares } = require('./shares');
  const allShares = getShares();
  const tmShares = allShares.filter(s => s.timeMachine);

  // Check if vfs_fruit module exists
  let fruitSupported = true;
  try {
    const testCheck = await run('find /usr/lib* -name "*vfs_fruit*" 2>/dev/null || true');
    if (!testCheck || testCheck.trim() === '') {
      fruitSupported = false;
    }
  } catch (e) {
    fruitSupported = true;
  }

  // Check Avahi daemon
  let avahiActive = false;
  let avahiEnabled = false;
  try {
    const activeOut = await run('systemctl is-active avahi-daemon 2>/dev/null || echo inactive');
    avahiActive = (activeOut.trim() === 'active');
  } catch (e) {}
  try {
    const enabledOut = await run('systemctl is-enabled avahi-daemon 2>/dev/null || echo disabled');
    avahiEnabled = (enabledOut.trim() === 'enabled');
  } catch (e) {}

  // Gather share details and scan for backup bundles
  const detectedBackups = [];
  const sharesWithStats = [];

  for (const s of tmShares) {
    let sizeBytes = 0;
    let sizeFormatted = '0 B';
    if (s.path && fs.existsSync(s.path)) {
      try {
        const duOut = await run(`du -sb "${s.path}" 2>/dev/null || du -sh "${s.path}" 2>/dev/null`);
        const p = duOut.split(/\s+/);
        sizeBytes = parseInt(p[0]) || 0;
        sizeFormatted = formatBytes(sizeBytes);
      } catch (e) {}

      const bundles = await scanFolderForBundles(s.path, s.name);
      detectedBackups.push(...bundles);
    }

    sharesWithStats.push({
      ...s,
      usedBytes: sizeBytes,
      usedFormatted: sizeFormatted,
      maxSize: s.timeMachineMaxSize || '0 (Korlátlan)',
      bundleCount: detectedBackups.filter(b => b.shareName === s.name).length
    });
  }

  // Get storage info
  let storageStats = { total: '0 B', used: '0 B', free: '0 B', percent: 0 };
  try {
    const { getStorageInfo } = require('./system');
    const baseTarget = tmShares.length > 0 && tmShares[0].path ? tmShares[0].path : '/srv/samba';
    const sInfo = await getStorageInfo(baseTarget);
    storageStats = {
      total: sInfo.total,
      used: sInfo.used,
      free: sInfo.free,
      percent: sInfo.percent
    };
  } catch (e) {}

  const serverIp = getPrimaryLanIp();
  const hostname = os.hostname();

  return {
    success: true,
    fruitSupported,
    avahi: {
      active: avahiActive,
      enabled: avahiEnabled,
      serviceFileExists: fs.existsSync(AVAHI_SERVICE_FILE)
    },
    server: {
      ip: serverIp,
      hostname
    },
    storage: storageStats,
    shares: sharesWithStats,
    sharesCount: tmShares.length,
    backups: detectedBackups,
    backupsCount: detectedBackups.length
  };
}

/**
 * 1-Click Quick Setup for an Apple Time Machine Share.
 */
async function quickSetupTimeMachineShare({
  name = 'TimeMachine',
  folderPath,
  comment = 'Apple Time Machine Biztonsági Mentések (macOS)',
  maxSize = '1000G',
  validUsers = '',
  writeList = '',
  isPublic = false
}, adminUser = 'admin') {
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name.trim())) {
    throw new Error('Érvénytelen Time Machine megosztási név! Csak betűk, számok, kötőjel és alulvonás engedélyezett.');
  }

  const { saveShare } = require('./shares');
  const targetName = name.trim();
  const targetPath = folderPath && folderPath.trim() ? path.resolve(folderPath.trim()) : `/srv/samba/${targetName}`;

  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }

  // Set proper permissions for backup directories
  if (isPublic) {
    await run(`chmod 0777 "${targetPath}" 2>/dev/null`).catch(() => {});
  } else {
    await run(`chmod 2775 "${targetPath}" 2>/dev/null`).catch(() => {});
  }

  // Normalize max size
  let safeMaxSize = '';
  if (maxSize && String(maxSize).trim() && String(maxSize).trim() !== '0') {
    const trimmed = String(maxSize).trim().toUpperCase();
    if (!/^[0-9]+[KMGT]?B?$/i.test(trimmed)) {
      throw new Error('Érvénytelen méretkorlát formátum (pl. 500G, 1T, 2000M vagy 0 korlátlanhoz)');
    }
    safeMaxSize = trimmed;
  }

  const sharePayload = {
    name: targetName,
    folderPath: targetPath,
    comment: comment.trim() || 'Apple Time Machine Backup',
    isPublic: !!isPublic,
    readOnly: false,
    disabled: false,
    recycle: false, // Time machine should avoid Samba recycle bin overhead
    timeMachine: true,
    timeMachineMaxSize: safeMaxSize,
    validUsers: validUsers ? validUsers.trim() : '',
    writeList: writeList ? writeList.trim() : ''
  };

  const result = await saveShare(sharePayload, adminUser);
  await syncAvahiTimeMachineService();

  logEvent('timemachine', `Time Machine megosztás létrehozva: [${targetName}] (${targetPath}, max: ${safeMaxSize || 'Korlátlan'})`, adminUser, { name: targetName, targetPath, safeMaxSize });

  return {
    success: true,
    share: result,
    name: targetName,
    path: targetPath,
    maxSize: safeMaxSize
  };
}

/**
 * Remove stale lock files from a sparsebundle when a Mac backup is stuck or interrupted.
 */
async function cleanupStaleLocks(targetPath, bundleName, adminUser = 'admin') {
  if (!targetPath) throw new Error('Elérési út megadása kötelező!');
  const absPath = path.resolve(targetPath);
  const bundleFullPath = bundleName ? path.join(absPath, bundleName) : absPath;

  if (!fs.existsSync(bundleFullPath)) {
    throw new Error('A megadott mentési csomag nem található!');
  }

  const removedFiles = [];
  const lockTargets = ['token', '.lock', '.RecoveryToken'];

  for (const lock of lockTargets) {
    const lockFile = path.join(bundleFullPath, lock);
    if (fs.existsSync(lockFile)) {
      try {
        fs.unlinkSync(lockFile);
        removedFiles.push(lock);
      } catch (e) {}
    }
  }

  // Also unlock bands directory if permissions were altered
  const bandsDir = path.join(bundleFullPath, 'bands');
  if (fs.existsSync(bandsDir)) {
    await run(`chmod -R u+rw "${bandsDir}" 2>/dev/null`).catch(() => {});
  }

  logEvent('timemachine', `Time Machine zárlatok feloldva: ${bundleFullPath} (${removedFiles.join(', ') || 'nincs aktív fájlzár'})`, adminUser);
  return {
    success: true,
    cleanedBundle: path.basename(bundleFullPath),
    removedLocks: removedFiles
  };
}

/**
 * Generate customized macOS connection instructions.
 */
function getMacGuide(shareName = 'TimeMachine') {
  const ip = getPrimaryLanIp();
  const smbUrl = `smb://${ip}/${shareName}`;
  const tmCommand = `sudo tmutil setdestination -p "smb://<felhasznalonev>@${ip}/${shareName}"`;

  return {
    serverIp: ip,
    shareName,
    smbUrl,
    tmCommand,
    steps: [
      {
        step: 1,
        title: 'Nyisd meg a Time Machine beállításokat a Mac-en',
        description: 'Válaszd az Apple menü ➔ Rendszerbeállítások (System Settings) ➔ Általános (General) ➔ Time Machine menüpontot.'
      },
      {
        step: 2,
        title: 'Adj hozzá új biztonsági mentési lemezt',
        description: 'Kattints a "+" (Biztonsági mentési lemez hozzáadása) gombra. Az Avahi mDNS felderítésnek köszönhetően a szerver automatikusan megjelenik.'
      },
      {
        step: 3,
        title: 'Válaszd ki a hálózati megosztást',
        description: `Válaszd a(z) "${shareName}" nevű lemezt, majd add meg a Samba felhasználóneved és jelszavad.`
      },
      {
        step: 4,
        title: 'Biztonsági mentés titkosítása (Opcionális)',
        description: 'Igény esetén jelöld be a "Mentés titkosítása" opciót a Mac oldali jelszavas védelemhez.'
      },
      {
        step: 5,
        title: 'Automatikus háttérmentés elindult',
        description: 'A macOS óránként automatikusan és csendben végrehajtja a növekményes biztonsági mentéseket.'
      }
    ]
  };
}

module.exports = {
  syncAvahiTimeMachineService,
  getTimeMachineStatus,
  quickSetupTimeMachineShare,
  cleanupStaleLocks,
  getMacGuide,
  scanFolderForBundles
};
