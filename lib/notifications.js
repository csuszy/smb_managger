const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');

const NOTIF_CONFIG_FILE = path.join(__dirname, '../data/notification_config.json');

function loadNotifConfig() {
  try {
    if (fs.existsSync(NOTIF_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(NOTIF_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {}
  return {
    discord: {
      enabled: false,
      webhookUrl: ''
    },
    smtp: {
      enabled: false,
      host: '',
      port: 587,
      secure: false, // true for 465 SSL/TLS, false for STARTTLS
      user: '',
      pass: '',
      fromEmail: '',
      toEmail: ''
    },
    events: {
      userChanges: true,
      shareChanges: true,
      serviceAlerts: true,
      storageAlerts: true
    }
  };
}

function saveNotifConfig(cfg) {
  const dir = path.dirname(NOTIF_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(NOTIF_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// ============================================
// DISCORD WEBHOOK SENDER
// ============================================
function sendDiscordWebhook(webhookUrl, title, description, color = 0x8b5cf6) {
  return new Promise((resolve, reject) => {
    if (!webhookUrl || !webhookUrl.startsWith('http')) {
      return reject(new Error('Érvénytelen Discord Webhook URL!'));
    }

    const payload = JSON.stringify({
      username: 'SMB Manager Alert',
      avatar_url: 'https://raw.githubusercontent.com/csuszy/smb_managger/main/public/favicon.ico',
      embeds: [
        {
          title: title,
          description: description,
          color: color,
          timestamp: new Date().toISOString(),
          footer: {
            text: 'NAS SMB Manager Notifications'
          }
        }
      ]
    });

    const urlObj = new URL(webhookUrl);
    const client = urlObj.protocol === 'https:' ? https : http;

    const req = client.request(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve({ success: true });
      } else {
        reject(new Error(`Discord API válasz HTTP ${res.statusCode}`));
      }
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Időtúllépés a Discord Webhook elérésekor'));
    });

    req.write(payload);
    req.end();
  });
}

// ============================================
// SMTP EMAIL SENDER (ZERO DEPENDENCY)
// ============================================
function sendSmtpEmail(smtpConfig, subject, textBody) {
  return new Promise((resolve, reject) => {
    const { host, port = 587, secure = false, user, pass, fromEmail, toEmail } = smtpConfig;
    if (!host || !toEmail) {
      return reject(new Error('Hiányzó SMTP szerver vagy fogadó e-mail cím!'));
    }

    const socketModule = secure ? tls : net;
    const socket = socketModule.connect({ host, port: parseInt(port), rejectUnauthorized: false }, () => {
      step();
    });

    let buffer = '';
    let currentStep = 0;

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop(); // keep last unfinished line

      for (const line of lines) {
        if (/^\d{3}[ -]/.test(line)) {
          const code = parseInt(line.substring(0, 3));
          if (code >= 400) {
            socket.end();
            return reject(new Error(`SMTP hiba (${code}): ${line}`));
          }
        }
      }
      step();
    });

    socket.on('error', (err) => reject(err));
    socket.setTimeout(15000, () => {
      socket.destroy();
      reject(new Error('Időtúllépés az SMTP kapcsolat során'));
    });

    function send(cmd) {
      socket.write(cmd + '\r\n');
    }

    function step() {
      currentStep++;
      if (currentStep === 1) {
        send(`EHLO ${host}`);
      } else if (currentStep === 2) {
        if (!secure && port === 587) {
          send('STARTTLS');
        } else if (user && pass) {
          send('AUTH LOGIN');
        } else {
          currentStep = 5;
          step();
        }
      } else if (currentStep === 3) {
        if (!secure && port === 587) {
          // Upgrade to TLS socket after STARTTLS
          const tlsSocket = tls.connect({
            socket: socket,
            rejectUnauthorized: false
          }, () => {
            if (user && pass) {
              send('AUTH LOGIN');
            } else {
              currentStep = 5;
              step();
            }
          });
          tlsSocket.on('data', (d) => socket.emit('data', d));
          tlsSocket.on('error', (e) => socket.emit('error', e));
        } else if (user) {
          send(Buffer.from(user).toString('base64'));
        }
      } else if (currentStep === 4) {
        if (pass) {
          send(Buffer.from(pass).toString('base64'));
        }
      } else if (currentStep === 5) {
        send(`MAIL FROM:<${fromEmail || user || 'noreply@smb-manager.local'}>`);
      } else if (currentStep === 6) {
        send(`RCPT TO:<${toEmail}>`);
      } else if (currentStep === 7) {
        send('DATA');
      } else if (currentStep === 8) {
        const mailContent = [
          `From: ${fromEmail || user || 'SMB Manager'} <${fromEmail || user || 'noreply@smb-manager.local'}>`,
          `To: <${toEmail}>`,
          `Subject: ${subject}`,
          'Content-Type: text/plain; charset=UTF-8',
          '',
          textBody,
          '.'
        ].join('\r\n');
        send(mailContent);
      } else if (currentStep === 9) {
        send('QUIT');
        socket.end();
        resolve({ success: true });
      }
    }
  });
}

// ============================================
// MAIN NOTIFY EVENT HANDLER
// ============================================
async function notifyEvent(category, title, message, color = 0x8b5cf6) {
  const cfg = loadNotifConfig();
  const promises = [];

  // Check event toggles
  if (category === 'users' && !cfg.events.userChanges) return;
  if (category === 'shares' && !cfg.events.shareChanges) return;
  if (category === 'service' && !cfg.events.serviceAlerts) return;
  if (category === 'storage' && !cfg.events.storageAlerts) return;

  if (cfg.discord && cfg.discord.enabled && cfg.discord.webhookUrl) {
    promises.push(
      sendDiscordWebhook(cfg.discord.webhookUrl, title, message, color).catch(e => {
        console.error('Discord webhook hiba:', e.message);
      })
    );
  }

  if (cfg.smtp && cfg.smtp.enabled && cfg.smtp.host && cfg.smtp.toEmail) {
    promises.push(
      sendSmtpEmail(cfg.smtp, `[SMB Manager] ${title}`, message).catch(e => {
        console.error('SMTP Email hiba:', e.message);
      })
    );
  }

  await Promise.all(promises);
}

module.exports = {
  loadNotifConfig,
  saveNotifConfig,
  sendDiscordWebhook,
  sendSmtpEmail,
  notifyEvent
};
