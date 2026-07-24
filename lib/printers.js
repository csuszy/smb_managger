const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const os = require('os');
const { logEvent } = require('./audit');
const { notifyEvent } = require('./notifications');
const { loadConfig } = require('./auth');

function getSambaBase() {
  try {
    const cfg = loadConfig();
    return cfg.storageBasePath || '/srv/samba';
  } catch (e) {
    return '/srv/samba';
  }
}

const PRINTER_CONFIG_FILE = path.join(__dirname, '../data/printer_config.json');
const PRINTER_LOG_FILE = path.join(__dirname, '../data/printer_log.json');

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

function getPrintLogs() {
  try {
    if (fs.existsSync(PRINTER_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(PRINTER_LOG_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function logPrintActivity({ type = 'print', status = 'info', file = '', printer = '', message = '', error = '' }) {
  try {
    let logs = getPrintLogs();
    const entry = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      dateFormatted: new Date().toLocaleString('hu-HU'),
      type,    // 'print' | 'cups' | 'folder' | 'email' | 'test' | 'socket'
      status,  // 'success' | 'error' | 'pending' | 'warning'
      file: file ? path.basename(file) : '',
      printer,
      message,
      error: error ? String(error) : ''
    };
    logs.unshift(entry);
    logs = logs.slice(0, 100); // Keep max 100 recent entries
    const dir = path.dirname(PRINTER_LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PRINTER_LOG_FILE, JSON.stringify(logs, null, 2), 'utf8');
    return entry;
  } catch (e) {
    console.error('Error writing printer log:', e);
  }
}

function clearPrintLogs() {
  try {
    const dir = path.dirname(PRINTER_LOG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PRINTER_LOG_FILE, '[]', 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

async function getActiveJobs() {
  const jobs = [];
  try {
    const out = await run('lpstat -o 2>/dev/null || true');
    if (!out) return jobs;
    const lines = out.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 4) {
        jobs.push({
          jobId: parts[0],
          user: parts[1],
          size: parts[2],
          date: parts.slice(3).join(' ')
        });
      }
    }
  } catch (e) {}
  return jobs;
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
      monitoredFolder: path.join(getSambaBase(), 'Print', 'nyomtatas'),
      archiveFolder: path.join(getSambaBase(), 'Print', 'archive'),
      checkIntervalSec: 10
    },
    emailPrint: {
      enabled: false,
      host: '',
      port: 993,
      tls: true,
      user: '',
      password: '',
      subjectFilter: 'NYOMTATAS',
      checkIntervalMin: 2
    }
  };
}

function savePrinterConfig(cfg) {
  const current = loadPrinterConfig();

  // Merge config to PRESERVE manualPrinters and nested settings when updating!
  const merged = {
    ...current,
    ...cfg,
    manualPrinters: cfg.manualPrinters !== undefined ? cfg.manualPrinters : (current.manualPrinters || []),
    folderPrint: { ...(current.folderPrint || {}), ...(cfg.folderPrint || {}) },
    emailPrint: { ...(current.emailPrint || {}), ...(cfg.emailPrint || {}) }
  };

  const dir = path.dirname(PRINTER_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PRINTER_CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');

  ensurePrintFolders(merged);

  // Sync default printer with CUPS system default destination
  if (merged.defaultPrinter) {
    run(`lpoptions -d "${merged.defaultPrinter}" 2>/dev/null && lpadmin -d "${merged.defaultPrinter}" 2>/dev/null`).catch(() => {});
  }

  // Restart watchers with new config
  startFolderPrintWatcher();
  startEmailPrintWatcher();
}

function ensurePrintFolders(cfg) {
  const base = getSambaBase();
  const printBase = path.join(base, 'Print');
  const printDir = (cfg.folderPrint && cfg.folderPrint.monitoredFolder) ? cfg.folderPrint.monitoredFolder : path.join(printBase, 'nyomtatas');
  const archiveDir = (cfg.folderPrint && cfg.folderPrint.archiveFolder) ? cfg.folderPrint.archiveFolder : path.join(printBase, 'archive');

  if (!fs.existsSync(printDir)) fs.mkdirSync(printDir, { recursive: true });
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

  try {
    run(`chmod -R 0777 "${printBase}" 2>/dev/null`).catch(() => {});
  } catch (e) {}

  // Automatically share/unshare
  (async () => {
    try {
      const { getShares, saveShare, deleteShare } = require('./shares');
      const shares = getShares();
      const existingPrint = shares.find(s => s.name === 'nyomtatas');
      const existingArchive = shares.find(s => s.name === 'nyomtatas_archiv');
      
      if (cfg.enabled && cfg.folderPrint && cfg.folderPrint.enabled) {
        if (!existingPrint || existingPrint.path !== printDir || existingPrint.disabled) {
          await saveShare({
            name: 'nyomtatas',
            folderPath: printDir,
            comment: 'Automatikus Nyomtatási Bemeneti Mappa',
            isPublic: false,
            readOnly: true,
            validUsers: '@users',
            disabled: false,
            recycle: false
          }, 'system');
        }
        if (!existingArchive || existingArchive.path !== archiveDir || existingArchive.disabled) {
          await saveShare({
            name: 'nyomtatas_archiv',
            folderPath: archiveDir,
            comment: 'Nyomtatott Dokumentumok Archívuma',
            isPublic: false,
            readOnly: true,
            validUsers: '@users',
            disabled: false,
            recycle: false
          }, 'system');
        }
      } else {
        if (existingPrint) {
          await deleteShare('nyomtatas', 'system');
        }
        if (existingArchive) {
          await deleteShare('nyomtatas_archiv', 'system');
        }
      }
    } catch (err) {
      console.error('ensurePrintFolders sharing error:', err);
    }
  })();
}

// Check if CUPS / lpstat CLI is installed
async function isCupsInstalled() {
  try {
    await run('which lpstat 2>/dev/null');
    return true;
  } catch (e) {
    return false;
  }
}

// Discover system CUPS printers and manual network printers with deduplication
async function getPrinters() {
  const printerMap = new Map();
  let cupsDefault = '';
  const cupsInstalled = await isCupsInstalled();

  // 1. CUPS printers (if installed)
  if (cupsInstalled) {
    try {
      const out = await run('lpstat -p -d 2>/dev/null || true');
      const lines = out.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('system default destination:')) {
          cupsDefault = trimmed.split(':').slice(1).join(':').trim();
        } else if (trimmed.startsWith('printer ')) {
          const parts = trimmed.split(/\s+/);
          const name = parts[1];
          const status = trimmed.includes('disabled') ? 'Disabled' : (trimmed.includes('idle') ? 'Idle' : 'Printing');
          if (name) {
            printerMap.set(name, {
              id: name,
              name: name,
              status,
              type: 'cups',
              isCups: true
            });
          }
        }
      }
    } catch (e) {}
  }

  // 2. Manual & Network printers from config
  const cfg = loadPrinterConfig();
  if (Array.isArray(cfg.manualPrinters)) {
    for (const p of cfg.manualPrinters) {
      const pId = p.id || `net_${p.ip.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const existing = printerMap.get(pId);

      printerMap.set(pId, {
        id: pId,
        name: p.name || `Nyomtató (${p.ip})`,
        ip: p.ip,
        port: p.port || 9100,
        status: existing ? existing.status : 'Hálózati (IP)',
        type: existing ? 'cups' : (p.type || 'raw'),
        isCups: !!existing
      });
    }
  }

  const printers = Array.from(printerMap.values());

  // Determine active default printer ID
  let defaultPrinter = cfg.defaultPrinter;
  if (!defaultPrinter || !printers.some(p => p.id === defaultPrinter)) {
    defaultPrinter = cupsDefault || (printers.length > 0 ? printers[0].id : '');
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
async function registerPrinterInCups(printer) {
  const { id, ip, port, type } = printer;
  const uri = type === 'ipp' ? `ipp://${ip}:${port}/ipp/print` : `socket://${ip}:${port}`;
  
  try {
    // Try setting up as driverless everywhere first
    await run(`lpadmin -p "${id}" -E -v "${uri}" -m everywhere`);
    console.log(`Printer ${id} registered in CUPS with everywhere driver`);
  } catch (e) {
    // Fallback to raw mode
    try {
      await run(`lpadmin -p "${id}" -E -v "${uri}" -m raw`);
      console.log(`Printer ${id} registered in CUPS with raw driver`);
    } catch (e2) {
      console.error(`Failed to register printer ${id} in CUPS:`, e2.message);
    }
  }
}

async function syncManualPrintersWithCups() {
  const cfg = loadPrinterConfig();
  if (Array.isArray(cfg.manualPrinters)) {
    for (const p of cfg.manualPrinters) {
      await registerPrinterInCups(p).catch(() => {});
    }
  }
}

async function addManualPrinter({ name, ip, port = 9100, type = 'raw' }) {
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

  // Register in CUPS
  await registerPrinterInCups(printerData).catch(() => {});

  logEvent('config', `Hálózati nyomtató hozzáadva: ${name || ip} (${ip}:${port})`, 'admin');
  return { success: true, printer: printerData };
}

// Remove manual printer
async function removeManualPrinter(idOrIp) {
  const cfg = loadPrinterConfig();
  if (!Array.isArray(cfg.manualPrinters)) return { success: true };

  const printer = cfg.manualPrinters.find(p => p.id === idOrIp || p.ip === idOrIp);
  const printerId = printer ? printer.id : idOrIp;

  cfg.manualPrinters = cfg.manualPrinters.filter(p => p.id !== idOrIp && p.ip !== idOrIp);
  if (cfg.defaultPrinter === idOrIp) cfg.defaultPrinter = '';
  savePrinterConfig(cfg);

  // Delete from CUPS
  await run(`lpadmin -x "${printerId}" 2>/dev/null`).catch(() => {});

  logEvent('config', `Hálózati nyomtató eltávolítva: ${idOrIp}`, 'admin');
  return { success: true };
}

// Direct network raw socket print
function printToRawSocket(ip, port = 9100, filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return reject(new Error('A nyomtatandó fájl nem található!'));
    const fileName = path.basename(filePath);

    logPrintActivity({
      type: 'socket',
      status: 'pending',
      file: fileName,
      printer: `${ip}:${port}`,
      message: `Kapcsolódás a hálózati nyomtatóhoz (Raw Socket: ${ip}:${port})...`
    });

    const socket = new net.Socket();
    const fileStream = fs.createReadStream(filePath);

    socket.setTimeout(15000);

    socket.connect(port, ip, () => {
      fileStream.pipe(socket);
    });

    fileStream.on('end', () => {
      setTimeout(() => {
        socket.end();
        logPrintActivity({
          type: 'socket',
          status: 'success',
          file: fileName,
          printer: `${ip}:${port}`,
          message: `Fájl sikeresen átküldve a nyomtatónak (${ip}:${port})`
        });
        resolve(true);
      }, 1000);
    });

    socket.on('error', (err) => {
      fileStream.destroy();
      socket.destroy();
      const errMsg = `Hálózati nyomtatási hiba (${ip}:${port}): ${err.message}`;
      logPrintActivity({
        type: 'socket',
        status: 'error',
        file: fileName,
        printer: `${ip}:${port}`,
        message: `Nem sikerült a nyomtatóhoz kapcsolódni`,
        error: errMsg
      });
      reject(new Error(errMsg));
    });

    socket.on('timeout', () => {
      fileStream.destroy();
      socket.destroy();
      const errMsg = `Időtúllépés a hálózati nyomtató elérésekor (${ip}:${port})`;
      logPrintActivity({
        type: 'socket',
        status: 'error',
        file: fileName,
        printer: `${ip}:${port}`,
        message: `Nyomtató nem válaszol (Timeout)`,
        error: errMsg
      });
      reject(new Error(errMsg));
    });
  });
}

function generateTestPageFile() {
  const tmpPath = path.join('/tmp', `test_print_${Date.now()}.txt`);
  const content = `
=====================================================
            SambaHub — TEST PRINT PAGE
=====================================================
  Date & Time : ${new Date().toLocaleString('hu-HU')}
  Host        : ${os.hostname()}
  OS / Arch   : ${os.type()} ${os.arch()}

  Congratulations! Your printer is properly
  configured and working with SambaHub NAS Admin.
=====================================================
\x0C`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.chmodSync(tmpPath, 0o666);
  return tmpPath;
}

// Print file to printer (CUPS or Direct Raw Socket)
async function printFile(filePath, printerId = '') {
  if (!fs.existsSync(filePath)) throw new Error('A nyomtatandó fájl nem található!');

  const fileName = path.basename(filePath);
  const cfg = loadPrinterConfig();
  const printersInfo = await getPrinters();
  
  // Resolve target printer ID
  const targetId = printerId || cfg.defaultPrinter || printersInfo.defaultPrinter || '';
  const manual = (cfg.manualPrinters || []).find(p => p.id === targetId || p.ip === targetId);

  logPrintActivity({
    type: 'print',
    status: 'pending',
    file: fileName,
    printer: targetId || 'Alapértelmezett',
    message: `Nyomtatási feladat indítása: ${fileName}`
  });

  // Copy to /tmp to avoid CUPS sandbox / permission issues (since cupsd runs as lp user)
  const tmpPath = path.join('/tmp', `print_${Date.now()}_${fileName}`);
  try {
    fs.copyFileSync(filePath, tmpPath);
    fs.chmodSync(tmpPath, 0o666);
  } catch (e) {
    console.error('Failed to copy print file to /tmp:', e.message);
  }

  const printTarget = tmpPath && fs.existsSync(tmpPath) ? tmpPath : filePath;

  try {
    // 1. If we have a targetId or manual printer, try CUPS printing with explicit destination first
    if (targetId) {
      try {
        const cmd = `lp -d "${targetId}" "${printTarget}" 2>&1`;
        const result = await run(cmd);

        logPrintActivity({
          type: 'cups',
          status: 'success',
          file: fileName,
          printer: targetId,
          message: `CUPS feladat elfogadva: ${result}`
        });

        logEvent('files', `Fájl kinyomtatva (CUPS): ${fileName} -> ${targetId}`, 'admin');
        notifyEvent('files', '🜁 Nyomtatás Sikeres', `Fájl kinyomtatva: ${fileName} (${targetId})`, 0x06b6d4).catch(() => {});
        return { success: true, message: `Kinyomtatva (${targetId}): ${result}` };
      } catch (e) {
        console.warn(`CUPS printing failed for destination ${targetId}:`, e.message);
        logPrintActivity({
          type: 'cups',
          status: 'warning',
          file: fileName,
          printer: targetId,
          message: `CUPS nyomtatás nem sikerült, próbálkozás Raw Socketen...`,
          error: e.message
        });

        if (manual && manual.ip) {
          try {
            await printToRawSocket(manual.ip, manual.port || 9100, printTarget);
            logEvent('files', `Fájl kinyomtatva (Raw Socket): ${fileName} -> ${manual.ip}:${manual.port}`, 'admin');
            notifyEvent('files', '🜁 Nyomtatás Sikeres', `Fájl kinyomtatva: ${fileName} (${manual.name || manual.ip})`, 0x06b6d4).catch(() => {});
            return { success: true, message: `Kinyomtatva Raw Socketen (${manual.ip})` };
          } catch (socketErr) {
            throw new Error(`Nem sikerült kapcsolódni a nyomtatóhoz (${manual.ip}): ${socketErr.message}`);
          }
        }
        throw new Error(`Nyomtatási hiba (${targetId}): ${e.message}`);
      }
    }

    // 2. Fallback to default CUPS print if targetId is empty
    try {
      const cmd = `lp "${printTarget}" 2>&1`;
      const result = await run(cmd);
      logPrintActivity({
        type: 'cups',
        status: 'success',
        file: fileName,
        printer: 'Rendszer Alapértelmezett',
        message: `Kinyomtatva: ${result}`
      });
      logEvent('files', `Fájl kinyomtatva: ${fileName} (Alapértelmezett)`, 'admin');
      notifyEvent('files', '🜁 Nyomtatás Sikeres', `Fájl kinyomtatva: ${fileName} (Alapértelmezett)`, 0x06b6d4).catch(() => {});
      return { success: true, message: result };
    } catch (e) {
      const errMsg = `Nem sikerült a nyomtatás. Kérlek válassz ki egy nyomtatót a beállításokban! (${e.message})`;
      logPrintActivity({
        type: 'cups',
        status: 'error',
        file: fileName,
        printer: 'Hiányzik',
        message: `Nincs elérhető alapértelmezett nyomtató`,
        error: e.message
      });
      throw new Error(errMsg);
    }
  } finally {
    // Cleanup tmp file
    try {
      if (tmpPath && fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch (e) {}
  }
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
  // Always ensure folder print share state matches config
  ensurePrintFolders(cfg);

  if (!cfg.enabled || !cfg.folderPrint || !cfg.folderPrint.enabled) return;

  const base = getSambaBase();
  const monitoredFolder = cfg.folderPrint.monitoredFolder || path.join(base, 'Print', 'nyomtatas');
  const archiveFolder = cfg.folderPrint.archiveFolder || path.join(base, 'Print', 'archive');
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

// =========================================================
// EMAIL-TO-PRINT IMAP ENGINE
// =========================================================
let emailWatchTimer = null;

// Parse attachments from raw MIME string
function extractMimeAttachments(mimeRaw) {
  const attachments = [];
  const boundaryMatch = mimeRaw.match(/boundary="?([^"\r\n]+)"?/i);

  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = mimeRaw.split('--' + boundary);

    for (const part of parts) {
      if (part.includes('Content-Disposition') || part.includes('filename=')) {
        const filenameMatch = part.match(/filename="?([^"\r\n;]+)"?/i) || part.match(/name="?([^"\r\n;]+)"?/i);
        if (filenameMatch) {
          let filename = filenameMatch[1].trim().replace(/^["']|["']$/g, '');
          filename = filename.replace(/[^a-zA-Z0-9_\.\-]/g, '_');

          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd !== -1) {
            const bodyContent = part.substring(headerEnd + 4).trim();
            const encodingMatch = part.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i);
            const encoding = encodingMatch ? encodingMatch[1].trim().toLowerCase() : '7bit';

            let fileBuffer;
            if (encoding === 'base64') {
              fileBuffer = Buffer.from(bodyContent.replace(/\s+/g, ''), 'base64');
            } else {
              fileBuffer = Buffer.from(bodyContent, 'utf8');
            }

            if (fileBuffer && fileBuffer.length > 0) {
              attachments.push({ filename, data: fileBuffer });
            }
          }
        }
      }
    }
  }

  return attachments;
}

const RECENT_EMAILS_FILE = path.join(__dirname, '../data/recent_emails.json');

function decodeMimeHeader(val) {
  if (!val) return '';
  const regex = /=\?([^?]+)\?([QB])\?([^?]+)\?=/gi;
  return val.replace(regex, (match, charset, encoding, text) => {
    if (encoding.toUpperCase() === 'B') {
      try {
        return Buffer.from(text, 'base64').toString(charset.toLowerCase() === 'utf-8' ? 'utf8' : 'binary');
      } catch (e) { return match; }
    } else if (encoding.toUpperCase() === 'Q') {
      try {
        const hexDecoded = text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, hex) => {
          return String.fromCharCode(parseInt(hex, 16));
        });
        return Buffer.from(hexDecoded, 'binary').toString('utf8');
      } catch (e) { return match; }
    }
    return match;
  });
}

function getRecentEmailsLog() {
  try {
    if (fs.existsSync(RECENT_EMAILS_FILE)) {
      return JSON.parse(fs.readFileSync(RECENT_EMAILS_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function addRecentEmailToLog(emailEntry) {
  try {
    let log = getRecentEmailsLog();
    if (log.some(e => e.date === emailEntry.date && e.subject === emailEntry.subject && e.from === emailEntry.from)) return;
    
    log.unshift(emailEntry);
    log = log.slice(0, 20);
    
    const dir = path.dirname(RECENT_EMAILS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RECENT_EMAILS_FILE, JSON.stringify(log, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving recent emails log:', e);
  }
}

// Zero-dependency IMAP client for Email-To-Print
function checkImapEmailAccount(emailCfg) {
  return new Promise((resolve, reject) => {
    if (!emailCfg.host || !emailCfg.user || !emailCfg.password) {
      return reject(new Error('Hiányzó IMAP fiók adatok!'));
    }

    const host = emailCfg.host.trim();
    const port = parseInt(emailCfg.port) || 993;
    const user = emailCfg.user.trim();
    const pass = emailCfg.password;
    const filter = (emailCfg.subjectFilter || 'NYOMTATAS').trim().toUpperCase();

    const socket = tls.connect(port, host, { rejectUnauthorized: false }, () => {});

    socket.setTimeout(25000);
    socket.setEncoding('utf8');

    let tagIndex = 1;
    let currentStep = 0; // 0: greeting, 1: login, 2: select, 3: search, 4: fetch, 5: logout
    let buffer = '';
    let msgIds = [];
    let savedFilesCount = 0;

    const sendCmd = (cmd) => {
      const tag = `A${tagIndex++}`;
      socket.write(`${tag} ${cmd}\r\n`);
      return tag;
    };

    let currentTag = '';

    socket.on('data', (data) => {
      buffer += data;
      const lines = buffer.split('\r\n');

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];

        if (currentStep === 0 && line.includes('* OK')) {
          currentStep = 1;
          currentTag = sendCmd(`LOGIN "${user}" "${pass.replace(/"/g, '\\"')}"`);
        } else if (currentStep === 1 && line.startsWith(currentTag)) {
          if (line.includes('OK')) {
            currentStep = 2;
            currentTag = sendCmd('SELECT INBOX');
          } else {
            socket.end();
            return reject(new Error('IMAP Bejelentkezési hiba: ' + line));
          }
        } else if (currentStep === 2 && line.startsWith(currentTag)) {
          if (line.includes('OK')) {
            currentStep = 3;
            currentTag = sendCmd(`SEARCH UNSEEN SUBJECT "${filter}"`);
          } else {
            socket.end();
            return reject(new Error('IMAP INBOX megnyitási hiba: ' + line));
          }
        } else if (currentStep === 3) {
          if (line.startsWith('* SEARCH')) {
            const parts = line.split(/\s+/).slice(2);
            msgIds = parts.filter(p => p && !isNaN(p));
          }
          if (line.startsWith(currentTag)) {
            if (msgIds.length === 0) {
              currentStep = 5;
              currentTag = sendCmd('LOGOUT');
            } else {
              currentStep = 4;
              const nextMsg = msgIds.shift();
              currentTag = sendCmd(`FETCH ${nextMsg} BODY[]`);
            }
          }
        } else if (currentStep === 4) {
          if (line.startsWith(currentTag)) {
            // Process MIME attachments from buffer
            const subjectMatch = buffer.match(/^Subject:\s*([^\r\n]+)/mi);
            const fromMatch = buffer.match(/^From:\s*([^\r\n]+)/mi);
            const dateMatch = buffer.match(/^Date:\s*([^\r\n]+)/mi);
            
            const subject = subjectMatch ? decodeMimeHeader(subjectMatch[1]) : 'Nincs tárgy';
            const from = fromMatch ? decodeMimeHeader(fromMatch[1]) : 'Ismeretlen';
            const date = dateMatch ? dateMatch[1].trim() : 'Ismeretlen';

            const attachments = extractMimeAttachments(buffer);
            const targetFolder = (emailCfg.monitoredFolder || path.join(getSambaBase(), 'Print', 'nyomtatas'));

            for (const att of attachments) {
              const filePath = path.join(targetFolder, `email_${Date.now()}_${att.filename}`);
              fs.writeFileSync(filePath, att.data);
              savedFilesCount++;
              logEvent('files', `✉️ E-mail csatolmány kimentve nyomtatásra: ${att.filename}`, 'email_watcher');
              notifyEvent('files', '✉️ E-mail Nyomtatási Csatolmány', `Új fájl érkezett e-mailből: ${att.filename}`, 0x8b5cf6).catch(() => {});
            }

            // Save to recent emails log
            addRecentEmailToLog({
              id: currentTag + '_' + Date.now(),
              from: from,
              subject: subject,
              date: date,
              files: attachments.map(a => a.filename),
              timestamp: new Date().toISOString()
            });

            buffer = '';

            if (msgIds.length > 0) {
              const nextMsg = msgIds.shift();
              currentTag = sendCmd(`FETCH ${nextMsg} BODY[]`);
            } else {
              currentStep = 5;
              currentTag = sendCmd('LOGOUT');
            }
          }
        } else if (currentStep === 5 && line.startsWith(currentTag)) {
          socket.end();
          resolve({ success: true, savedFilesCount });
        }
      }
    });

    socket.on('error', (err) => {
      reject(new Error('IMAP Kapcsolódási hiba: ' + err.message));
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Időtúllépés az IMAP szerver elérésekor'));
    });
  });
}

function startEmailPrintWatcher() {
  if (emailWatchTimer) clearInterval(emailWatchTimer);

  const cfg = loadPrinterConfig();
  if (!cfg.enabled || !cfg.emailPrint || !cfg.emailPrint.enabled) return;

  const intervalMs = Math.max(1, (cfg.emailPrint.checkIntervalMin || 2)) * 60 * 1000;

  // Run immediately on enable
  checkImapEmailAccount(cfg.emailPrint).catch(() => {});

  emailWatchTimer = setInterval(() => {
    checkImapEmailAccount(cfg.emailPrint).catch(err => {
      console.error('Email-to-Print IMAP watcher error:', err.message);
    });
  }, intervalMs);
}

// Start watching on load
startFolderPrintWatcher();
startEmailPrintWatcher();
syncManualPrintersWithCups().catch(() => {});

module.exports = {
  loadPrinterConfig,
  savePrinterConfig,
  getPrinters,
  scanNetworkPrinters,
  addManualPrinter,
  removeManualPrinter,
  installCupsPackages,
  printFile,
  generateTestPageFile,
  startFolderPrintWatcher,
  startEmailPrintWatcher,
  checkImapEmailAccount,
  getRecentEmailsLog,
  syncManualPrintersWithCups,
  getPrintLogs,
  logPrintActivity,
  clearPrintLogs,
  getActiveJobs
};
