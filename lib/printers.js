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
      const existing = shares.find(s => s.name === 'nyomtatas');
      
      if (cfg.enabled && cfg.folderPrint && cfg.folderPrint.enabled) {
        if (!existing || existing.path !== printDir || existing.disabled) {
          await saveShare({
            name: 'nyomtatas',
            folderPath: printDir,
            comment: 'Automatikus Nyomtatási Mappa',
            isPublic: true,
            readOnly: false,
            disabled: false,
            recycle: false
          }, 'system');
        }
      } else {
        if (existing) {
          await deleteShare('nyomtatas', 'system');
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

// Discover system CUPS printers and manual network printers
async function getPrinters() {
  const printers = [];
  let defaultPrinter = '';
  const cupsInstalled = await isCupsInstalled();

  // 1. CUPS printers (if installed)
  if (cupsInstalled) {
    try {
      const out = await run('lpstat -p -d 2>/dev/null || true');
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
    } catch (e) {}
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
    await printToRawSocket(manual.ip, manual.port || 9100, filePath);
    logEvent('files', `Fájl kinyomtatva (Hálózati IP): ${path.basename(filePath)} -> ${manual.ip}:${manual.port}`, 'admin');
    notifyEvent('files', '🜁 Nyomtatás Sikeres', `Fájl kinyomtatva: ${path.basename(filePath)} (${manual.name})`, 0x06b6d4).catch(() => {});
    return { success: true, message: `Kinyomtatva (${manual.ip})` };
  }

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
            const attachments = extractMimeAttachments(buffer);
            const targetFolder = (emailCfg.monitoredFolder || path.join(getSambaBase(), 'Print', 'nyomtatas'));

            for (const att of attachments) {
              const filePath = path.join(targetFolder, `email_${Date.now()}_${att.filename}`);
              fs.writeFileSync(filePath, att.data);
              savedFilesCount++;
              logEvent('files', `✉️ E-mail csatolmány kimentve nyomtatásra: ${att.filename}`, 'email_watcher');
              notifyEvent('files', '✉️ E-mail Nyomtatási Csatolmány', `Új fájl érkezett e-mailből: ${att.filename}`, 0x8b5cf6).catch(() => {});
            }

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

module.exports = {
  loadPrinterConfig,
  savePrinterConfig,
  getPrinters,
  scanNetworkPrinters,
  addManualPrinter,
  removeManualPrinter,
  installCupsPackages,
  printFile,
  startFolderPrintWatcher,
  startEmailPrintWatcher,
  checkImapEmailAccount
};
