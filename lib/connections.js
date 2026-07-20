const { exec } = require('child_process');
const { logEvent } = require('./audit');

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

// Get active connections using smbstatus
async function getActiveConnections() {
  const connections = [];
  try {
    const smbstatus = await run('smbstatus -b 2>/dev/null || smbstatus -p 2>/dev/null');
    const lines = smbstatus.split('\n');
    let inSection = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('PID') && trimmed.includes('Username')) {
        inSection = true;
        continue;
      }
      if (trimmed.startsWith('---')) continue;
      if (trimmed.startsWith('Samba version')) continue;

      if (inSection || /^\d+/.test(trimmed)) {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 4 && /^\d+$/.test(parts[0])) {
          connections.push({
            pid: parts[0],
            user: parts[1],
            group: parts[2],
            machine: parts[3],
            protocol: parts[4] || 'SMB3',
            encryption: parts[5] || '-'
          });
        }
      }
    }
  } catch (e) {}

  // Get share connections via smbstatus -S
  try {
    const sharesOut = await run('smbstatus -S 2>/dev/null');
    const sLines = sharesOut.split('\n');
    for (const line of sLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('Service') || trimmed.startsWith('---')) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 3) {
        const service = parts[0];
        const pid = parts[1];
        const machine = parts[2];
        const connectedAt = parts.slice(3).join(' ');
        
        // Find matching connection
        const match = connections.find(c => c.pid === pid);
        if (match) {
          match.share = service;
          match.connectedAt = connectedAt;
        }
      }
    }
  } catch (e) {}

  return connections;
}

// Kill connection by PID
async function killConnection(pid, adminUser = 'admin') {
  if (!pid || !/^\d+$/.test(pid)) throw new Error('Érvénytelen PID');

  try {
    await run(`smbstatus -k ${pid} 2>/dev/null || kill -9 ${pid} 2>&1`);
  } catch (e) {
    await run(`kill -9 ${pid} 2>&1`).catch(() => {});
  }

  logEvent('auth', `Kapcsolat bontva PID: ${pid}`, adminUser, { pid });
  return { success: true, pid };
}

module.exports = { getActiveConnections, killConnection };
