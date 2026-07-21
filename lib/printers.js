const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
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
    folderPrint: {
      enabled: true,
      monitoredFolder: '/srv/samba/Print/nyomtatas',
      archiveFolder: '/srv/samba/Print/archive',
      checkIntervalSec: 10
    },
    emailPrint: {
      enabled: false,
      host: '',
      port: 993,
      user: '',
      pass: '',
      subjectFilter: 'PRINT',
      checkIntervalSec: 60
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

// Discover system printers via lpstat / CUPS
async function getPrinters() {
  const printers = [];
  let defaultPrinter = '';

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
        if (name) printers.push({ name, status });
      }
    }
  } catch (e) {}

  return { printers, defaultPrinter };
}

// Print file to printer
async function printFile(filePath, printerName = '') {
  if (!fs.existsSync(filePath)) throw new Error('A nyomtatandó fájl nem található!');

  const cmd = printerName ? `lp -d "${printerName}" "${filePath}" 2>&1` : `lp "${filePath}" 2>&1`;
  const result = await run(cmd);

  logEvent('files', `Fájl kinyomtatva: ${path.basename(filePath)} (Nyomtató: ${printerName || 'Alapértelmezett'})`, 'admin');
  notifyEvent('files', '🜁 Nyomtatás Sikeres', `Fájl kinyomtatva: ${path.basename(filePath)} (Nyomtató: ${printerName || 'Alapértelmezett'})`, 0x06b6d4).catch(() => {});

  return { success: true, message: result };
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
            // Print file
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
  printFile,
  startFolderPrintWatcher
};
