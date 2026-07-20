const fs = require('fs');
const path = require('path');

const AUDIT_FILE = path.join(__dirname, '../data/audit_log.json');

// Ensure directory and file exist
function initAudit() {
  const dir = path.dirname(AUDIT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(AUDIT_FILE)) fs.writeFileSync(AUDIT_FILE, '[]', 'utf8');
}

initAudit();

function getLogs() {
  try {
    const data = fs.readFileSync(AUDIT_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

function logEvent(category, action, user, details = {}, ip = '127.0.0.1') {
  try {
    const logs = getLogs();
    const event = {
      id: 'evt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp: new Date().toISOString(),
      category, // 'auth' | 'users' | 'groups' | 'shares' | 'permissions' | 'files' | 'config' | 'service'
      action,
      user: user || 'system',
      ip,
      details
    };
    logs.unshift(event);
    // Keep last 1000 events
    if (logs.length > 1000) logs.length = 1000;
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(logs, null, 2), 'utf8');
    return event;
  } catch (e) {
    console.error('Failed to log audit event:', e);
  }
}

function filterLogs({ category, user, search, limit = 100 }) {
  let logs = getLogs();
  if (category && category !== 'all') {
    logs = logs.filter(l => l.category === category);
  }
  if (user && user !== 'all') {
    logs = logs.filter(l => l.user.toLowerCase() === user.toLowerCase());
  }
  if (search) {
    const q = search.toLowerCase();
    logs = logs.filter(l => 
      l.action.toLowerCase().includes(q) ||
      l.user.toLowerCase().includes(q) ||
      l.category.toLowerCase().includes(q) ||
      JSON.stringify(l.details).toLowerCase().includes(q)
    );
  }
  return logs.slice(0, parseInt(limit));
}

module.exports = { logEvent, getLogs, filterLogs };
