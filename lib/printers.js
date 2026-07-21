const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { logEvent } = require('./audit');
const { notifyEvent } = require('./notifications');

const PRINTER_CONFIG_FILE = path.join(__dirname, '../data/printer_config.json');

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

function loadPrinterConfig() {
  try {
    if (fs.existsSync(PRINTER_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(PRINTER_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
    enabled: false,
    defaultPrinter: '',
    manualPrinters: [], // [{ id, name, ip, port, type: 'raw' | 'ipp' }]
    folderPrint: {
      enabled: true,
      monitoredFolder: '/srv/samba/Print/nyomtatas',
      archiveFolder: '/srv/samba/Print/archive',
      checkIntervalSec: 10
    }
  };
}

function savePrinterConfig(cfg) {
  const dir = path.dirname(PRINTER_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PRINTER_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');

  if (cfg.enabled) {
    ensurePrintFolders(cfg);
  }
}

function ensurePrintFolders(cfg) {
  const printBase = path.join('/srv/samba', 'Print');
  const printDir = (cfg.folderPrint && cfg.folderPrint.monitoredFolder) ? cfg.folderPrint.monitoredFolder : path.join(printBase, 'nyomtatas');
  const archiveDir = (cfg.folderPrint && cfg.folderPrint.archiveFolder) ? cfg.folderPrint.archiveFolder : path.join(printBase, 'archive');

  if (!fs.existsSync(printDir)) fs.mkdirSync(printDir, { recursive: true });
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  try {
    run(`chmod -R 0777 "${printBase}" 2>/dev/null`).catch(() => {});
  } catch (e) {}
}

// Discover system CUPS printers and manual network printers
async function getPrinters() {
  const printers = [];
  let defaultPrinter = '';
  let cupsInstalled = true;

  // 1. CUPS printers
  try {
    const out = await run('lpstat -p -d 2>/dev/null || lpstat -a 2>/dev/null');
    const lines = out.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('system default destination:')) {
        defaultPrinter = trimmed.split(':').slice(1).join(':').trim();
      } else if (trimmed.startsWith('printer ')) {
        const parts = trimmed.split(/\s+/);
        const name = parts[1];
        const status = trimmed.includes('disabled') ? 'Disabled' : (trimmed.includes('idle') ? 'Idle' : 'Printing');
        if (name) printers.push({ id: name, name, status, type: 'cups' });
      }
    }
  } catch (e) {
    cupsInstalled = false;
  }

  // 2. Manual & Network printers from config
  const cfg = loadPrinterConfig();
  if (Array.isArray(cfg.manualPrinters)) {
    for (const p of cfg.manualPrinters) {
      printers.push({
        id: p.id || p.ip,
        name: p.name || `Nyomtató (${p.ip})`,
        ip: p.ip,
        port: p.port || 9100,
        status: 'Hálózati (IP)',
        type: p.type || 'raw'
      });
    }
  }

  if (!defaultPrinter && printers.length > 0) {
    defaultPrinter = cfg.defaultPrinter || printers[0].name || printers[0].id;
  }

  return { printers, defaultPrinter, cupsInstalled };
}

// Scan local subnet for active IP printers (Port 9100 JetDirect or Port 631 IPP)
async function scanNetworkPrinters() {
  const interfaces = os.networkInterfaces();
  let localIp = '';

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4' && iface.address.startsWith('192.168.')) {
        localIp = iface.address;
        break;
      }
    }
  }

  if (!localIp) return [];

  const subnetPrefix = localIp.substring(0, localIp.lastIndexOf('.'));
  const found = [];

  const checkPort = (ip, port, timeout = 600) => {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeout);
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, ip);
    });
  };

  // Scan IPs 1..254 concurrently in batches
  const batchSize = 30;
  for (let i = 1; i <= 254; i += batchSize) {
    const promises = [];
    for (let j = i; j < i + batchSize && j <= 254; j++) {
      const targetIp = `${subnetPrefix}.${j}`;
      promises.push(
        Promise.all([checkPort(targetIp, 9100), checkPort(targetIp, 631)]).then(([p9100, p631]) => {
          if (p9100 || p631) {
            found.push({
              ip: targetIp,
              name: `Hálózati Nyomtató (${targetIp})`,
              port: p9100 ? 9100 : 631,
              type: p9100 ? 'raw' : 'ipp'
            });
          }
        })
      );
    }
    await Promise.all(promises);
  }

  return found;
}

// Add manual network printer
function addManualPrinter({ name, ip, port = 9100, type = 'raw' }) {
  if (!ip) throw new Error('A nyomtató IP címe megadása kötelező!');
  const cfg = loadPrinterConfig();
  if (!Array.isArray(cfg.manualPrinters)) cfg.manualPrinters = [];

  const id = `net_${ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const existingIdx = cfg.manualPrinters.findIndex(p => p.ip === ip || p.id === id);

  const printerData = { id, name: name || `Nyomtató (${ip})`, ip, port: parseInt(port) || 9100, type };

  if (existingIdx >= 0) {
    cfg.manualPrinters[existingIdx] = printerData;
  } else {
    cfg.manualPrinters.push(printerData);
  }

  if (!cfg.defaultPrinter) cfg.defaultPrinter = id;
  savePrinterConfig(cfg);

  logEvent('config', `Hálózati nyomtató hozzáadva: ${name || ip} (${ip}:${port})`, 'admin');
  return { success: true, printer: printerData };
}

// Remove manual printer
function removeManualPrinter(idOrIp) {
  const cfg = loadPrinterConfig();
  if (!Array.isArray(cfg.manualPrinters)) return { success: true };

  cfg.manualPrinters = cfg.manualPrinters.filter(p => p.id !== idOrIp && p.ip !== idOrIp);
  if (cfg.defaultPrinter === idOrIp) cfg.defaultPrinter = '';
  savePrinterConfig(cfg);

  logEvent('config', `Hálózati nyomtató eltávolítva: ${idOrIp}`, 'admin');
  return { success: true };
}

// Direct network raw socket print
function printToRawSocket(ip, port = 9100, filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return reject(new Error('A nyomtatandó fájl nem található!'));

    const socket = new net.Socket();
    const fileStream = fs.createReadStream(filePath);

    socket.setTimeout(15000);

    socket.connect(port, ip, () => {
      fileStream.pipe(socket);
    });

    fileStream.on('end', () => {
      setTimeout(() => {
        socket.end();
        resolve(true);
      }, 1000);
    });

    socket.on('error', (err) => {
      fileStream.destroy();
      socket.destroy();
      reject(new Error(`Hálózati nyomtatási hiba (${ip}:${port}): ${err.message}`));
    });

    socket.on('timeout', () => {
      fileStream.destroy();
      socket.destroy();
      reject(new Error(`Időtúllépés a hálózati nyomtató elérésekor (${ip}:${port})`));
    });
  });
}

// Print file to printer (CUPS or Direct Raw Socket)
async function printFile(filePath, printerId = '') {
  if (!fs.existsSync(filePath)) throw new Error('A nyomtatandó fájl nem található!');

  const cfg = loadPrinterConfig();
  const manual = (cfg.manualPrinters || []).find(p => p.id === printerId || p.ip === printerId);

  if (manual) {
    // Print directly to network IP printer via RAW socket / IPP
    await printToRawSocket(manual.ip, manual.port || 9100, filePath);
    logEvent('files', `Fájl kinyomtatva (Hálózati IP): ${path.basename(filePath)} -> ${manual.ip}:${manual.port}`, 'admin');
    notifyEvent('files', '🜁 Nyomtatás Sikeres', `Fájl kinyomtatva: ${path.basename(filePath)} (${manual.name})`, 0x06b6d4).catch(() => {});
    return { success: true, message: `Kinyomtatva (${manual.ip})` };
  }

  // Try CUPS print
  const cmd = printerId ? `lp -d "${printerId}" "${filePath}" 2>&1` : `lp "${filePath}" 2>&1`;
  const result = await run(cmd);

  logEvent('files', `Fájl kinyomtatva: ${path.basename(filePath)} (Nyomtató: ${printerId || 'Alapértelmezett'})`, 'admin');
  notifyEvent('files', '🜁 Nyomtatás Sikeres', `Fájl kinyomtatva: ${path.basename(filePath)} (Nyomtató: ${printerId || 'Alapértelmezett'})`, 0x06b6d4).catch(() => {});

  return { success: true, message: result };
}

// Install CUPS packages
async function installCupsPackages() {
  await run('apt-get update && apt-get install -y cups cups-client cups-filters avahi-daemon 2>&1');
  await run('systemctl enable --now cups 2>/dev/null || service cups start 2>/dev/null').catch(() => {});
  logEvent('system', 'CUPS nyomtató szolgáltatás telepítve és elindítva', 'admin');
  return { success: true, message: 'CUPS csomagok sikeresen telepítve!' };
}

// Folder watcher loop for auto-printing dropped files
let folderWatchTimer = null;

function startFolderPrintWatcher() {
  if (folderWatchTimer) clearInterval(folderWatchTimer);

  const cfg = loadPrinterConfig();
  if (!cfg.enabled || !cfg.folderPrint || !cfg.folderPrint.enabled) return;

  ensurePrintFolders(cfg);

  const monitoredFolder = cfg.folderPrint.monitoredFolder || '/srv/samba/Print/nyomtatas';
  const archiveFolder = cfg.folderPrint.archiveFolder || '/srv/samba/Print/archive';
  const intervalMs = (cfg.folderPrint.checkIntervalSec || 10) * 1000;

  folderWatchTimer = setInterval(async () => {
    try {
      if (!fs.existsSync(monitoredFolder)) return;
      const files = fs.readdirSync(monitoredFolder);

      for (const file of files) {
        if (file.startsWith('.')) continue;
        const filePath = path.join(monitoredFolder, file);

        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile()) {
            const printersInfo = await getPrinters();
            const targetPrinter = cfg.defaultPrinter || printersInfo.defaultPrinter || '';

            await printFile(filePath, targetPrinter).catch(err => {
              console.error(`Nyomtatási hiba (${file}):`, err.message);
            });

            // Move to archive folder
            const destPath = path.join(archiveFolder, `${Date.now()}_${file}`);
            fs.renameSync(filePath, destPath);
          }
        } catch (e) {
          console.error(`Folder print processing error for ${file}:`, e);
        }
      }
    } catch (e) {}
  }, intervalMs);
}

// Start watching on load
startFolderPrintWatcher();

module.exports = {
  loadPrinterConfig,
  savePrinterConfig,
  getPrinters,
  scanNetworkPrinters,
  addManualPrinter,
  removeManualPrinter,
  installCupsPackages,
  printFile,
  startFolderPrintWatcher
};
