const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

// System Information
async function getSystemInfo() {
  const uptimeSeconds = os.uptime();
  const days = Math.floor(uptimeSeconds / (3600 * 24));
  const hours = Math.floor((uptimeSeconds % (3600 * 24)) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  let kernel = '';
  try { kernel = await run('uname -r'); } catch (e) { kernel = os.release(); }

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
  const ipAddress = candidates.length > 0 ? candidates[0].address : '127.0.0.1';

  return {
    hostname: os.hostname(),
    ipAddress,
    platform: os.platform() + ' ' + os.arch(),
    kernel,
    uptime: `${days}d ${hours}h ${minutes}m`,
    cpuModel: cpus[0] ? cpus[0].model : 'Generic CPU',
    cpuCores: cpus.length,
    loadAvg: os.loadavg().map(l => l.toFixed(2)),
    memory: {
      total: (totalMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      used: (usedMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      free: (freeMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
      percent: Math.round((usedMem / totalMem) * 100)
    }
  };
}

// Storage Overview (df -h)
async function getStorageInfo(sambaBase = '/srv/samba') {
  let dfOutput = '';
  try {
    dfOutput = await run(`df -B1 "${sambaBase}" 2>/dev/null || df -B1 /`);
  } catch (e) {
    dfOutput = await run('df -B1 /');
  }

  const lines = dfOutput.trim().split('\n');
  let totalBytes = 0, usedBytes = 0, freeBytes = 0, percent = 0, filesystem = '/';

  if (lines.length >= 2) {
    const parts = lines[1].trim().split(/\s+/);
    filesystem = parts[0];
    totalBytes = parseInt(parts[1]) || 0;
    usedBytes = parseInt(parts[2]) || 0;
    freeBytes = parseInt(parts[3]) || 0;
    percent = parseInt(parts[4]) || 0;
  }

  // Calculate share directory sizes
  const shareSizes = [];
  try {
    if (fs.existsSync(sambaBase)) {
      const entries = fs.readdirSync(sambaBase, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const folderPath = path.join(sambaBase, entry.name);
          let sizeStr = '0 B';
          let bytes = 0;
          try {
            const duOut = await run(`du -sb "${folderPath}" 2>/dev/null || du -sh "${folderPath}" 2>/dev/null`);
            const p = duOut.split(/\s+/);
            bytes = parseInt(p[0]) || 0;
            sizeStr = formatBytes(bytes);
          } catch (e) {}
          shareSizes.push({ name: entry.name, path: folderPath, size: sizeStr, bytes });
        }
      }
    }
  } catch (e) {}

  return {
    filesystem,
    total: formatBytes(totalBytes),
    used: formatBytes(usedBytes),
    free: formatBytes(freeBytes),
    totalBytes,
    usedBytes,
    freeBytes,
    percent,
    shareSizes
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// User Quota Management
const QUOTA_DB_FILE = path.join(__dirname, '../data/user_quotas.json');

function getUserQuotas() {
  try {
    if (!fs.existsSync(QUOTA_DB_FILE)) return {};
    return JSON.parse(fs.readFileSync(QUOTA_DB_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

async function setUserQuota(username, limitMB) {
  const quotas = getUserQuotas();
  if (limitMB && parseInt(limitMB) > 0) {
    quotas[username] = parseInt(limitMB);
    // Try system setquota if block quota enabled
    try {
      const soft = parseInt(limitMB) * 1024; // in KB
      const hard = soft;
      await run(`setquota -u ${username} ${soft} ${hard} 0 0 / 2>/dev/null`).catch(() => {});
    } catch (e) {}
  } else {
    delete quotas[username];
    try {
      await run(`setquota -u ${username} 0 0 0 0 / 2>/dev/null`).catch(() => {});
    } catch (e) {}
  }
  const dir = path.dirname(QUOTA_DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(QUOTA_DB_FILE, JSON.stringify(quotas, null, 2), 'utf8');
  return quotas;
}

module.exports = { getSystemInfo, getStorageInfo, getUserQuotas, setUserQuota, formatBytes };
