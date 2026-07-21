// =========================================================
// NAS SMB MANAGER — FRONTEND APPLICATION
// =========================================================

const API = '';

// Global State
let currentSection = 'dashboard';
let globalUsers = [];
let globalGroups = [];
let globalShares = [];
let currentPermFolder = '';
let currentEditUser = null;
let currentEditShare = null;
let currentQuotaUser = null;

// --- Theme Toggle ---
const htmlEl = document.documentElement;
const themeBtn = document.getElementById('themeToggleBtn');

function initTheme() {
  const savedTheme = localStorage.getItem('nas_theme') || 'dark';
  htmlEl.setAttribute('data-theme', savedTheme);
  themeBtn.querySelector('.theme-icon').textContent = savedTheme === 'dark' ? '🌙' : '☀️';
}

themeBtn.addEventListener('click', () => {
  const cur = htmlEl.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  htmlEl.setAttribute('data-theme', next);
  localStorage.setItem('nas_theme', next);
  themeBtn.querySelector('.theme-icon').textContent = next === 'dark' ? '🌙' : '☀️';
  toast(`Téma váltva: ${next === 'dark' ? 'Sötét' : 'Világos'} mód`, 'success');
});

initTheme();

// --- Navigation ---
const navItems = document.querySelectorAll('.nav-item');
const sections = document.querySelectorAll('.content-section');

navItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const targetSection = item.dataset.section;
    switchSection(targetSection);
  });
});

function switchSection(sectionId) {
  currentSection = sectionId;
  navItems.forEach(n => {
    n.classList.toggle('active', n.dataset.section === sectionId);
  });
  sections.forEach(s => {
    s.classList.toggle('active', s.id === `section-${sectionId}`);
  });

  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');

  // Load section data
  switch (sectionId) {
    case 'dashboard': refreshDashboard(); break;
    case 'users': loadUsers(); break;
    case 'groups': loadGroups(); break;
    case 'shares': loadShares(); break;
    case 'folder-manager': loadInteractiveExplorer(); break;
    case 'permissions': loadPermissionsView(); break;
    case 'connections': loadConnections(); break;
    case 'audit': loadAuditLogs(); break;
    case 'storage': loadStorage(); break;
    case 'recycle': loadRecycleFiles(); break;
    case 'snapshots': loadSnapshots(); break;
    case 'printers': loadPrintersView(); break;
    case 'samba-config': loadSambaGuiConfig(); break;
    case 'settings': loadSettings(); break;
  }
}

// Mobile sidebar toggle
document.getElementById('hamburger').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});

// Toast notification
function toast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// Modal helper
function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('open');
}

document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', (e) => {
    if (e.target === m) m.classList.remove('open');
  });
});

// Generic API Fetch Helpers & Token Handling
function getAuthToken() {
  return localStorage.getItem('nas_auth_token') || '';
}

function getAuthHeaders(extra = {}) {
  const headers = { ...extra };
  const token = getAuthToken();
  if (token) headers['X-Auth-Token'] = token;
  return headers;
}

async function apiGet(url) {
  const res = await fetch(API + url, { headers: getAuthHeaders() });
  if (res.status === 401 || res.status === 428) {
    checkAuthStatus();
    throw new Error('Hitelesítés vagy telepítés szükséges');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Hálózati hiba');
  }
  return res.json();
}

async function apiPost(url, body = {}) {
  const res = await fetch(API + url, {
    method: 'POST',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  if (res.status === 401 || res.status === 428) {
    checkAuthStatus();
    throw new Error('Hitelesítés vagy telepítés szükséges');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Művelet sikertelen');
  }
  return res.json();
}

async function apiPut(url, body = {}) {
  const res = await fetch(API + url, {
    method: 'PUT',
    headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  if (res.status === 401 || res.status === 428) {
    checkAuthStatus();
    throw new Error('Hitelesítés vagy telepítés szükséges');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Művelet sikertelen');
  }
  return res.json();
}

async function apiDelete(url) {
  const res = await fetch(API + url, {
    method: 'DELETE',
    headers: getAuthHeaders()
  });
  if (res.status === 401 || res.status === 428) {
    checkAuthStatus();
    throw new Error('Hitelesítés vagy telepítés szükséges');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Művelet sikertelen');
  }
  return res.json();
}

// =========================================================
// 1. DASHBOARD OVERVIEW
// =========================================================
async function refreshDashboard() {
  try {
    const data = await apiGet('/api/dashboard');

    // Counts
    document.getElementById('dashUsersCount').textContent = data.counts.users;
    document.getElementById('dashGroupsCount').textContent = data.counts.groups;
    document.getElementById('dashSharesCount').textContent = data.counts.shares;
    document.getElementById('dashConnCount').textContent = data.counts.connections;
    document.getElementById('navConnCount').textContent = data.counts.connections;

    // Service status
    const isActive = data.service.active === 'active';
    const sBadge = document.getElementById('dashServiceBadge');
    sBadge.className = `badge ${isActive ? 'badge-green' : 'badge-red'}`;
    sBadge.textContent = isActive ? 'Aktív (Fut)' : 'Inaktív (Leállítva)';

    const topDots = document.querySelectorAll('.status-dot');
    topDots.forEach(d => d.className = `status-dot ${isActive ? 'online' : 'offline'}`);
    document.getElementById('topStatusLabel').textContent = isActive ? 'Samba Online' : 'Samba Offline';

    // System info & IP
    const serverIp = data.system.ipAddress || location.hostname || '127.0.0.1';
    if (document.getElementById('topSmbIpValue')) document.getElementById('topSmbIpValue').textContent = serverIp;
    if (document.getElementById('dashSmbIpBadge')) document.getElementById('dashSmbIpBadge').textContent = serverIp;
    if (document.getElementById('dashSmbPathCode')) document.getElementById('dashSmbPathCode').textContent = `\\\\${serverIp}`;

    document.getElementById('sysHostname').textContent = data.system.hostname;
    document.getElementById('sysPlatform').textContent = data.system.platform;
    document.getElementById('sysUptime').textContent = data.system.uptime;
    document.getElementById('sysLoad').textContent = data.system.loadAvg.join(', ');
    document.getElementById('sysMemory').textContent = `${data.system.memory.used} / ${data.system.memory.total} (${data.system.memory.percent}%)`;
    document.getElementById('sysFilesystem').textContent = data.storage.filesystem;

    // Storage progress
    document.getElementById('dashStorageUsed').textContent = `${data.storage.used} használt`;
    document.getElementById('dashStorageTotal').textContent = `${data.storage.total} összesen`;
    document.getElementById('dashStorageFree').textContent = `${data.storage.free} szabad tárhely`;
    document.getElementById('dashStorageProgress').style.width = `${data.storage.percent}%`;

  } catch (e) {
    console.error('Dashboard hiba:', e);
  }
}

function copySmbPathToClipboard() {
  const codeEl = document.getElementById('dashSmbPathCode');
  if (codeEl) {
    navigator.clipboard.writeText(codeEl.textContent);
    toast(`Útvonal másolva a vágólapra: ${codeEl.textContent}`, 'success');
  }
}

async function serviceAction(action) {
  try {
    const res = await apiPost(`/api/service/${action}`);
    toast(`Szolgáltatás művelet (${action}) sikeres!`, 'success');
    refreshDashboard();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

// =========================================================
// 2. USERS MANAGEMENT
// =========================================================
async function loadUsers() {
  try {
    const data = await apiGet('/api/users');
    globalUsers = data.users || [];
    renderUsersTable(globalUsers);
  } catch (e) {
    toast('Hiba a felhasználók betöltésekor', 'error');
  }
}

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  if (!users || users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted">Nincsenek felhasználók</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => {
    const isDis = u.disabled;
    const groupsBadges = u.groups && u.groups.length > 0
      ? u.groups.map(g => `<span class="badge badge-purple">${g}</span>`).join(' ')
      : '<span class="text-muted">—</span>';

    return `
      <tr>
        <td><strong>${u.username}</strong></td>
        <td>${u.fullName || '—'}</td>
        <td>${groupsBadges}</td>
        <td>${u.quotaMB ? u.quotaMB + ' MB' : '<span class="text-muted">Korlátlan</span>'}</td>
        <td>${u.lastLogon || '<span class="text-muted">Ismeretlen</span>'}</td>
        <td>
          <span class="badge ${isDis ? 'badge-red' : 'badge-green'}">
            ${isDis ? 'Tiltva' : 'Aktív'}
          </span>
        </td>
        <td>
          <div class="flex-gap">
            <button class="btn btn-ghost btn-sm" onclick="openEditUserModal('${u.username}')">Szerkesztés</button>
            <button class="btn btn-ghost btn-sm" onclick="openUserPassModal('${u.username}')">Jelszó</button>
            <button class="btn btn-ghost btn-sm" onclick="toggleUserStatus('${u.username}', ${isDis})">
              ${isDis ? 'Engedélyezés' : 'Tiltás'}
            </button>
            <button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="confirmDeleteUser('${u.username}')">Törlés</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// User Search Filter
document.getElementById('usersSearchInput').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  const filtered = globalUsers.filter(u =>
    u.username.toLowerCase().includes(q) ||
    (u.fullName && u.fullName.toLowerCase().includes(q))
  );
  renderUsersTable(filtered);
});

async function openAddUserModal() {
  currentEditUser = null;
  document.getElementById('userModalTitle').textContent = 'Új Felhasználó Létrehozása';
  document.getElementById('uModalUsername').value = '';
  document.getElementById('uModalUsername').disabled = false;
  document.getElementById('uModalFullName').value = '';
  document.getElementById('uModalPassword').value = '';
  document.getElementById('uModalPassGroup').style.display = '';
  document.getElementById('uModalQuota').value = '0';

  // Render groups checkboxes
  const groups = await apiGet('/api/groups').catch(() => ({ groups: [] }));
  const container = document.getElementById('uModalGroupsCheckboxes');
  container.innerHTML = (groups.groups || []).map(g => `
    <label class="checkbox-row"><input type="checkbox" value="${g.name}" class="group-chk"> ${g.name}</label>
  `).join('');

  document.getElementById('userModal').classList.add('open');
}

async function openEditUserModal(username) {
  const u = globalUsers.find(x => x.username === username);
  if (!u) return;

  currentEditUser = username;
  document.getElementById('userModalTitle').textContent = `Felhasználó Szerkesztése: ${username}`;
  document.getElementById('uModalUsername').value = username;
  document.getElementById('uModalUsername').disabled = true;
  document.getElementById('uModalFullName').value = u.fullName || '';
  document.getElementById('uModalPassGroup').style.display = 'none';
  document.getElementById('uModalQuota').value = u.quotaMB || '0';

  const groups = await apiGet('/api/groups').catch(() => ({ groups: [] }));
  const container = document.getElementById('uModalGroupsCheckboxes');
  container.innerHTML = (groups.groups || []).map(g => `
    <label class="checkbox-row">
      <input type="checkbox" value="${g.name}" class="group-chk" ${u.groups && u.groups.includes(g.name) ? 'checked' : ''}> ${g.name}
    </label>
  `).join('');

  document.getElementById('userModal').classList.add('open');
}

async function saveUserFromModal() {
  const username = document.getElementById('uModalUsername').value.trim();
  const fullName = document.getElementById('uModalFullName').value.trim();
  const password = document.getElementById('uModalPassword').value;
  const quotaMB = parseInt(document.getElementById('uModalQuota').value) || 0;

  const chks = document.querySelectorAll('#uModalGroupsCheckboxes .group-chk:checked');
  const groups = Array.from(chks).map(c => c.value);

  try {
    if (currentEditUser) {
      await apiPut(`/api/users/${currentEditUser}`, { fullName, groups, quotaMB });
      toast(`Felhasználó '${currentEditUser}' frissítve!`, 'success');
    } else {
      if (!username || !password) return toast('Felhasználónév és jelszó kötelező!', 'error');
      await apiPost('/api/users', { username, password, fullName, groups, quotaMB });
      toast(`Felhasználó '${username}' létrehozva!`, 'success');
    }
    closeModal('userModal');
    loadUsers();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

function openUserPassModal(username) {
  currentEditUser = username;
  document.getElementById('userPassModalUser').textContent = `Felhasználó: ${username}`;
  document.getElementById('uModalNewPass').value = '';
  document.getElementById('userPassModal').classList.add('open');
}

async function saveUserPassword() {
  const password = document.getElementById('uModalNewPass').value;
  if (!password) return toast('Kérlek add meg az új jelszót!', 'error');

  try {
    await apiPut(`/api/users/${currentEditUser}/password`, { password });
    toast('Jelszó sikeresen frissítve!', 'success');
    closeModal('userPassModal');
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

async function toggleUserStatus(username, currentlyDisabled) {
  try {
    await apiPut(`/api/users/${username}/toggle`, { enable: currentlyDisabled });
    toast(`Felhasználó '${username}' ${currentlyDisabled ? 'engedélyezve' : 'tiltva'}!`, 'success');
    loadUsers();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

function confirmDeleteUser(username) {
  document.getElementById('confirmTitle').textContent = 'Felhasználó Törlése';
  document.getElementById('confirmText').textContent = `Biztosan törölni szeretnéd a "${username}" felhasználót?`;
  document.getElementById('confirmBtn').onclick = async () => {
    try {
      await apiDelete(`/api/users/${username}`);
      toast(`Felhasználó '${username}' törölve!`, 'success');
      loadUsers();
    } catch (e) {
      toast('Törlési hiba: ' + e.message, 'error');
    }
    closeModal('confirmModal');
  };
  document.getElementById('confirmModal').classList.add('open');
}

// =========================================================
// 3. GROUPS MANAGEMENT
// =========================================================
async function loadGroups() {
  try {
    const data = await apiGet('/api/groups');
    globalGroups = data.groups || [];
    const grid = document.getElementById('groupsGrid');

    if (!globalGroups || globalGroups.length === 0) {
      grid.innerHTML = '<div class="card"><p class="text-muted">Nincsenek csoportok</p></div>';
      return;
    }

    grid.innerHTML = globalGroups.map(g => {
      const membersHtml = g.members && g.members.length > 0
        ? g.members.map(m => `<span class="badge badge-purple">${m}</span>`).join(' ')
        : '<span class="text-muted">Nincsenek tagok</span>';

      return `
        <div class="card">
          <div class="card-header-flex">
            <h3>👥 ${g.name}</h3>
            <span class="badge badge-cyan">GID: ${g.gid}</span>
          </div>
          <div class="mt-12">
            <div class="metric-label">Tagok:</div>
            <div class="flex-gap mt-8">${membersHtml}</div>
          </div>
          <div class="form-actions mt-16">
            <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="confirmDeleteGroup('${g.name}')">Csoport Törlése</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    toast('Hiba a csoportok betöltésekor', 'error');
  }
}

function openAddGroupModal() {
  document.getElementById('gModalName').value = '';
  document.getElementById('groupModal').classList.add('open');
}

async function saveGroupFromModal() {
  const name = document.getElementById('gModalName').value.trim();
  if (!name) return toast('Add meg a csoport nevét!', 'error');

  try {
    await apiPost('/api/groups', { name });
    toast(`Csoport '${name}' létrehozva!`, 'success');
    closeModal('groupModal');
    loadGroups();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

function confirmDeleteGroup(groupName) {
  document.getElementById('confirmTitle').textContent = 'Csoport Törlése';
  document.getElementById('confirmText').textContent = `Biztosan törlöd a "${groupName}" csoportot?`;
  document.getElementById('confirmBtn').onclick = async () => {
    try {
      await apiDelete(`/api/groups/${groupName}`);
      toast(`Csoport '${groupName}' törölve!`, 'success');
      loadGroups();
    } catch (e) {
      toast('Hiba: ' + e.message, 'error');
    }
    closeModal('confirmModal');
  };
  document.getElementById('confirmModal').classList.add('open');
}

// =========================================================
// 4. SMB SHARES MANAGEMENT
// =========================================================
async function loadShares() {
  try {
    const data = await apiGet('/api/shares');
    globalShares = data.shares || [];
    const grid = document.getElementById('sharesGrid');

    if (!globalShares || globalShares.length === 0) {
      grid.innerHTML = '<div class="card"><p class="text-muted">Nincsenek megosztások</p></div>';
      return;
    }

    grid.innerHTML = globalShares.map(s => {
      let badges = '';
      if (s.isPublic) badges += '<span class="badge badge-green">Publikus</span> ';
      else badges += '<span class="badge badge-purple">Privát</span> ';
      if (s.readOnly) badges += '<span class="badge badge-amber">Csak Olvasható</span> ';
      if (s.disabled) badges += '<span class="badge badge-red">Inaktív</span> ';
      if (s.recycle) badges += '<span class="badge badge-cyan">Lomtár</span> ';

      return `
        <div class="card">
          <div class="card-header-flex">
            <h3>📁 [${s.name}]</h3>
            <div class="flex-gap">${badges}</div>
          </div>
          <p class="text-muted mt-8">${s.comment || 'Nincs leírás'}</p>
          <div class="mt-12 sys-info-list">
            <div class="sys-info-item"><span>Útvonal:</span> <code>${s.path}</code></div>
            <div class="sys-info-item"><span>Engedélyezett userek:</span> <strong>${s.validUsers || 'Mindenki'}</strong></div>
          </div>
          <div class="form-actions mt-16">
            <button class="btn btn-ghost btn-sm" onclick="openEditShareModal('${s.name}')">Szerkesztés</button>
            <button class="btn btn-ghost btn-sm" onclick="toggleShareStatus('${s.name}', ${s.disabled})">
              ${s.disabled ? 'Engedélyezés' : 'Tiltás'}
            </button>
            <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="confirmDeleteShare('${s.name}')">Törlés</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    toast('Hiba a megosztások betöltésekor', 'error');
  }
}

async function populateShareAccessCheckboxes(selectedValidStr = '', selectedWriteStr = '') {
  const vContainer = document.getElementById('sModalValidUsersGrid');
  const wContainer = document.getElementById('sModalWriteListGrid');
  vContainer.innerHTML = '<span class="text-muted">Betöltés...</span>';
  wContainer.innerHTML = '<span class="text-muted">Betöltés...</span>';

  try {
    const [uRes, gRes] = await Promise.all([apiGet('/api/users'), apiGet('/api/groups')]);
    const users = uRes.users || [];
    const groups = gRes.groups || [];

    const validSet = new Set(selectedValidStr.split(/\s+/).filter(Boolean));
    const writeSet = new Set(selectedWriteStr.split(/\s+/).filter(Boolean));

    let htmlValid = '';
    let htmlWrite = '';

    // Users
    users.forEach(u => {
      const isV = validSet.has(u.username);
      const isW = writeSet.has(u.username);
      htmlValid += `
        <label class="checkbox-chip">
          <input type="checkbox" value="${u.username}" class="s-valid-chk" ${isV ? 'checked' : ''}>
          <span>👤 ${u.username}</span>
        </label>
      `;
      htmlWrite += `
        <label class="checkbox-chip">
          <input type="checkbox" value="${u.username}" class="s-write-chk" ${isW ? 'checked' : ''}>
          <span>👤 ${u.username}</span>
        </label>
      `;
    });

    // Groups
    groups.forEach(g => {
      const gTag = `@${g.name}`;
      const isV = validSet.has(gTag) || validSet.has(g.name);
      const isW = writeSet.has(gTag) || writeSet.has(g.name);
      htmlValid += `
        <label class="checkbox-chip">
          <input type="checkbox" value="${gTag}" class="s-valid-chk" ${isV ? 'checked' : ''}>
          <span>👥 ${gTag}</span>
        </label>
      `;
      htmlWrite += `
        <label class="checkbox-chip">
          <input type="checkbox" value="${gTag}" class="s-write-chk" ${isW ? 'checked' : ''}>
          <span>👥 ${gTag}</span>
        </label>
      `;
    });

    vContainer.innerHTML = htmlValid || '<span class="text-muted">Nincsenek felhasználók/csoportok</span>';
    wContainer.innerHTML = htmlWrite || '<span class="text-muted">Nincsenek felhasználók/csoportok</span>';
  } catch (e) {
    vContainer.innerHTML = '<span class="text-muted">Hiba a lista betöltésekor</span>';
    wContainer.innerHTML = '<span class="text-muted">Hiba a lista betöltésekor</span>';
  }
}

async function openAddShareModal() {
  currentEditShare = null;
  document.getElementById('shareModalTitle').textContent = 'Új SMB Megosztás Létrehozása';
  document.getElementById('sModalName').value = '';
  document.getElementById('sModalName').disabled = false;
  document.getElementById('sModalPath').value = '/srv/samba/';
  document.getElementById('sModalComment').value = '';
  document.getElementById('sModalPublic').checked = false;
  document.getElementById('sModalReadOnly').checked = false;
  document.getElementById('sModalRecycle').checked = true;
  document.getElementById('sModalDisabled').checked = false;

  await populateShareAccessCheckboxes('', '');
  document.getElementById('shareModal').classList.add('open');
}

async function openEditShareModal(name) {
  const s = globalShares.find(x => x.name === name);
  if (!s) return;

  currentEditShare = name;
  document.getElementById('shareModalTitle').textContent = `Megosztás Szerkesztése: [${name}]`;
  document.getElementById('sModalName').value = s.name;
  document.getElementById('sModalName').disabled = true;
  document.getElementById('sModalPath').value = s.path;
  document.getElementById('sModalComment').value = s.comment;
  document.getElementById('sModalPublic').checked = s.isPublic;
  document.getElementById('sModalReadOnly').checked = s.readOnly;
  document.getElementById('sModalRecycle').checked = s.recycle;
  document.getElementById('sModalDisabled').checked = s.disabled;

  await populateShareAccessCheckboxes(s.validUsers || '', s.writeList || '');
  document.getElementById('shareModal').classList.add('open');
}

async function saveShareFromModal() {
  const name = document.getElementById('sModalName').value.trim();
  const folderPath = document.getElementById('sModalPath').value.trim();
  const comment = document.getElementById('sModalComment').value.trim();
  const isPublic = document.getElementById('sModalPublic').checked;
  const readOnly = document.getElementById('sModalReadOnly').checked;
  const recycle = document.getElementById('sModalRecycle').checked;
  const disabled = document.getElementById('sModalDisabled').checked;

  const validChks = document.querySelectorAll('.s-valid-chk:checked');
  const writeChks = document.querySelectorAll('.s-write-chk:checked');

  const validUsers = Array.from(validChks).map(c => c.value).join(' ');
  const writeList = Array.from(writeChks).map(c => c.value).join(' ');

  try {
    await apiPost('/api/shares', {
      name, folderPath, comment, isPublic, readOnly, recycle, disabled, validUsers, writeList
    });
    toast(`Megosztás [${name}] elmentve!`, 'success');
    closeModal('shareModal');
    loadShares();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

async function toggleShareStatus(name, currentlyDisabled) {
  try {
    await apiPut(`/api/shares/${name}/toggle`, { enable: currentlyDisabled });
    toast(`Megosztás [${name}] ${currentlyDisabled ? 'engedélyezve' : 'tiltva'}!`, 'success');
    loadShares();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

function confirmDeleteShare(name) {
  document.getElementById('confirmTitle').textContent = 'Megosztás Törlése';
  document.getElementById('confirmText').textContent = `Biztosan törlöd a [${name}] megosztást? (A fájlok megmaradnak)`;
  document.getElementById('confirmBtn').onclick = async () => {
    try {
      await apiDelete(`/api/shares/${name}`);
      toast(`Megosztás [${name}] törölve!`, 'success');
      loadShares();
    } catch (e) {
      toast('Hiba: ' + e.message, 'error');
    }
    closeModal('confirmModal');
  };
  document.getElementById('confirmModal').classList.add('open');
}

// =========================================================
// INTERACTIVE FOLDER MANAGER EXPLORER
// =========================================================
let currentExplorerPath = '/srv/samba';
let currentExplorerParent = null;

async function loadInteractiveExplorer(targetPath = null) {
  const pathUrl = targetPath || currentExplorerPath;
  try {
    const data = await apiGet(`/api/file-browser?path=${encodeURIComponent(pathUrl)}`);
    currentExplorerPath = data.currentPath;
    currentExplorerParent = data.parentPath;

    document.getElementById('fmCurrentPathBadge').textContent = currentExplorerPath;
    document.getElementById('fmParentBtn').disabled = !currentExplorerParent;

    const grid = document.getElementById('explorerCardsGrid');
    if (!data.items || data.items.length === 0) {
      grid.innerHTML = '<div class="card"><p class="text-muted">A mappa üres. Hozz létre egy új mappát a gombbal!</p></div>';
      return;
    }

    grid.innerHTML = data.items.map(item => {
      const isDir = item.isDirectory;
      const itemEscaped = item.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

      return `
        <div class="card" style="position:relative;">
          <div class="card-header-flex">
            <div style="display:flex;align-items:center;gap:12px;">
              <div class="metric-icon ${isDir ? 'purple' : 'cyan'}" style="width:40px;height:40px;font-size:1.2rem;">
                ${isDir ? '📁' : '📄'}
              </div>
              <div>
                <strong style="font-size:1rem;${isDir ? 'cursor:pointer;color:var(--purple);' : ''}" onclick="${isDir ? `loadInteractiveExplorer('${itemEscaped}')` : ''}">
                  ${item.name}
                </strong>
                <div class="text-muted" style="font-size:0.75rem;">${isDir ? 'Mappa' : formatBytes(item.size)}</div>
              </div>
            </div>
          </div>

          <div class="form-actions mt-16 flex-gap">
            ${isDir ? `<button class="btn btn-ghost btn-sm" onclick="loadInteractiveExplorer('${itemEscaped}')">Megnyitás</button>` : ''}
            ${isDir ? `<button class="btn btn-ghost btn-sm" onclick="openFolderPermissions('${itemEscaped}')">🔑 Jogosultságok</button>` : ''}
            ${isDir ? `<button class="btn btn-ghost btn-sm" onclick="convertFolderToShare('${itemEscaped}', '${item.name}')">📤 Megosztás</button>` : ''}
            ${isDir ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="confirmDeleteExplorerFolder('${itemEscaped}', '${item.name}')">Törlés</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

  } catch (e) {
    toast('Hiba a mappa böngészésekor: ' + e.message, 'error');
  }
}

function navigateExplorerUp() {
  if (currentExplorerParent) {
    loadInteractiveExplorer(currentExplorerParent);
  }
}

async function promptCreateSubfolder() {
  const folderName = prompt(`Új mappa létrehozása itt: ${currentExplorerPath}\nAdd meg a mappa nevét:`);
  if (!folderName || !folderName.trim()) return;

  try {
    await apiPost('/api/folders/create', { basePath: currentExplorerPath, name: folderName.trim() });
    toast(`Mappa '${folderName.trim()}' létrehozva!`, 'success');
    loadInteractiveExplorer(currentExplorerPath);
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

function convertFolderToShare(folderPath, folderName) {
  switchSection('shares');
  openAddShareModal();
  document.getElementById('sModalName').value = folderName;
  document.getElementById('sModalPath').value = folderPath;
}

function openFolderPermissions(folderPath) {
  switchSection('permissions');
  loadPermissionsForSelectedFolder(folderPath);
}

function confirmDeleteExplorerFolder(folderPath, folderName) {
  document.getElementById('confirmTitle').textContent = 'Mappa Törlése';
  document.getElementById('confirmText').textContent = `Biztosan törlöd a "${folderName}" mappát és teljes tartalmát?`;
  document.getElementById('confirmBtn').onclick = async () => {
    try {
      await apiDelete(`/api/folders/delete?folderPath=${encodeURIComponent(folderPath)}`);
      toast(`Mappa '${folderName}' törölve!`, 'success');
      loadInteractiveExplorer(currentExplorerPath);
    } catch (e) {
      toast('Törlési hiba: ' + e.message, 'error');
    }
    closeModal('confirmModal');
  };
  document.getElementById('confirmModal').classList.add('open');
}

// =========================================================
// 5. PERMISSIONS MANAGEMENT (VISUAL MATRIX)
// =========================================================
let currentFolderPermData = { users: [], groups: [] };

async function loadPermissionsView() {
  try {
    const sharesData = await apiGet('/api/shares');
    const select = document.getElementById('permFolderSelect');
    select.innerHTML = '<option value="">-- Mappa / Megosztás kiválasztása --</option>' +
      '<option value="/srv/samba/homes">🏠 Felhasználói Home Mappák (/srv/samba/homes)</option>' +
      sharesData.shares.map(s => `<option value="${s.path}">[${s.name}] — ${s.path}</option>`).join('');

    document.getElementById('permMatrixCard').style.display = 'none';
  } catch (e) {}
}

async function loadPermissionsForSelectedFolder(targetPath = null) {
  const folderPath = targetPath || document.getElementById('permFolderSelect').value;
  if (!folderPath) {
    document.getElementById('permMatrixCard').style.display = 'none';
    return;
  }

  currentPermFolder = folderPath;
  document.getElementById('permMatrixTitle').textContent = `Jogosultság Mátrix`;
  document.getElementById('permSelectedPathBadge').textContent = folderPath;

  try {
    const data = await apiGet(`/api/permissions?folderPath=${encodeURIComponent(folderPath)}`);
    currentFolderPermData = data;

    renderVisualPermCards();
    document.getElementById('permMatrixCard').style.display = '';
  } catch (e) {
    toast('Hiba a jogosultságok lekérdezésekor', 'error');
  }
}

function renderVisualPermCards() {
  // Users Cards
  const uContainer = document.getElementById('userPermCardsContainer');
  if (!currentFolderPermData.users || currentFolderPermData.users.length === 0) {
    uContainer.innerHTML = '<p class="text-muted">Nincsenek felhasználók</p>';
  } else {
    uContainer.innerHTML = currentFolderPermData.users.map(u => {
      const lvl = u.level || 'none';
      return `
        <div class="perm-card" id="perm-user-card-${u.name}">
          <div class="perm-card-header">
            <div class="perm-card-user">
              <div class="perm-card-avatar">${u.name.charAt(0).toUpperCase()}</div>
              <div>
                <div class="perm-card-name">${u.name}</div>
                <div class="perm-card-fullname">${u.fullName || 'Samba Felhasználó'}</div>
              </div>
            </div>
            <span class="badge ${lvl === 'full' ? 'badge-green' : (lvl === 'read' ? 'badge-cyan' : 'badge-red')}" id="perm-user-badge-${u.name}">
              ${lvl === 'full' ? 'Teljes Hozzáférés' : (lvl === 'read' ? 'Csak Olvasás' : 'Nincs Hozzáférés')}
            </span>
          </div>
          <div class="perm-btn-group">
            <button class="perm-btn ${lvl === 'none' ? 'active-none' : ''}" onclick="setPermLevel('user', '${u.name}', 'none')">🔒 Nincs</button>
            <button class="perm-btn ${lvl === 'read' ? 'active-read' : ''}" onclick="setPermLevel('user', '${u.name}', 'read')">👁️ Olvasás</button>
            <button class="perm-btn ${lvl === 'full' ? 'active-full' : ''}" onclick="setPermLevel('user', '${u.name}', 'full')">⭐ Teljes</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Groups Cards
  const gContainer = document.getElementById('groupPermCardsContainer');
  if (!currentFolderPermData.groups || currentFolderPermData.groups.length === 0) {
    gContainer.innerHTML = '<p class="text-muted">Nincsenek csoportok</p>';
  } else {
    gContainer.innerHTML = currentFolderPermData.groups.map(g => {
      const lvl = g.level || 'none';
      return `
        <div class="perm-card" id="perm-group-card-${g.name}">
          <div class="perm-card-header">
            <div class="perm-card-user">
              <div class="perm-card-avatar" style="background:var(--gradient-green);">👥</div>
              <div>
                <div class="perm-card-name">${g.name}</div>
                <div class="perm-card-fullname">Csoport</div>
              </div>
            </div>
            <span class="badge ${lvl === 'full' ? 'badge-green' : (lvl === 'read' ? 'badge-cyan' : 'badge-red')}" id="perm-group-badge-${g.name}">
              ${lvl === 'full' ? 'Teljes Hozzáférés' : (lvl === 'read' ? 'Csak Olvasás' : 'Nincs Hozzáférés')}
            </span>
          </div>
          <div class="perm-btn-group">
            <button class="perm-btn ${lvl === 'none' ? 'active-none' : ''}" onclick="setPermLevel('group', '${g.name}', 'none')">🔒 Nincs</button>
            <button class="perm-btn ${lvl === 'read' ? 'active-read' : ''}" onclick="setPermLevel('group', '${g.name}', 'read')">👁️ Olvasás</button>
            <button class="perm-btn ${lvl === 'full' ? 'active-full' : ''}" onclick="setPermLevel('group', '${g.name}', 'full')">⭐ Teljes</button>
          </div>
        </div>
      `;
    }).join('');
  }
}

function setPermLevel(type, name, level) {
  const list = type === 'user' ? currentFolderPermData.users : currentFolderPermData.groups;
  const target = list.find(item => item.name === name);
  if (target) {
    target.level = level;
    renderVisualPermCards();
  }
}

function applyPermPresetAll(level) {
  if (currentFolderPermData.users) {
    currentFolderPermData.users.forEach(u => u.level = level);
  }
  if (currentFolderPermData.groups) {
    currentFolderPermData.groups.forEach(g => g.level = level);
  }
  renderVisualPermCards();
  toast(`Előbeállítás (${level}) alkalmazva minden kártyára!`, 'info');
}

async function saveCurrentFolderPermissions() {
  const userPermissions = (currentFolderPermData.users || []).map(u => ({ name: u.name, perms: u.level }));
  const groupPermissions = (currentFolderPermData.groups || []).map(g => ({ name: g.name, perms: g.level }));

  try {
    await apiPost('/api/permissions', {
      folderPath: currentPermFolder,
      userPermissions,
      groupPermissions
    });
    toast('Jogosultságok sikeresen elmentve!', 'success');
  } catch (e) {
    toast('Hiba a mentéskor: ' + e.message, 'error');
  }
}

// =========================================================
// FILE BROWSER MODAL
// =========================================================
let fbCurrentPath = '/srv/samba';
let fbParentPath = null;

async function openFileBrowserModal(initialPath = '/srv/samba') {
  document.getElementById('fileBrowserModal').classList.add('open');
  await loadFileBrowserPath(initialPath);
}

async function loadFileBrowserPath(targetPath) {
  try {
    const data = await apiGet(`/api/file-browser?path=${encodeURIComponent(targetPath)}`);
    fbCurrentPath = data.currentPath;
    fbParentPath = data.parentPath;

    document.getElementById('fbCurrentPathText').textContent = fbCurrentPath;
    document.getElementById('fbParentBtn').disabled = !fbParentPath;

    const tbody = document.getElementById('fbTableBody');
    if (!data.items || data.items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-muted">A mappa üres</td></tr>';
      return;
    }

    tbody.innerHTML = data.items.map(item => `
      <tr>
        <td>
          <strong style="cursor:pointer;" onclick="${item.isDirectory ? `loadFileBrowserPath('${item.path.replace(/\\/g, '\\\\')}')` : ''}">
            ${item.isDirectory ? '📁' : '📄'} ${item.name}
          </strong>
        </td>
        <td><span class="badge ${item.isDirectory ? 'badge-purple' : 'badge-cyan'}">${item.isDirectory ? 'Mappa' : 'Fájl'}</span></td>
        <td>${item.isDirectory ? '—' : formatBytes(item.size)}</td>
        <td>
          ${item.isDirectory ? `<button class="btn btn-ghost btn-sm" onclick="loadFileBrowserPath('${item.path.replace(/\\/g, '\\\\')}')">Megnyitás</button>` : ''}
        </td>
      </tr>
    `).join('');

  } catch (e) {
    toast('Hiba a böngészéskor', 'error');
  }
}

function navigateFileBrowserParent() {
  if (fbParentPath) loadFileBrowserPath(fbParentPath);
}

function selectCurrentFolderForPerms() {
  closeModal('fileBrowserModal');
  switchSection('permissions');
  loadPermissionsForSelectedFolder(fbCurrentPath);
}

// =========================================================
// 9. SMART RECYCLE BIN
// =========================================================
let currentRecycleFiles = [];
let selectedRecycleIds = new Set();

async function loadRecycleFiles() {
  try {
    const data = await apiGet('/api/recycle');
    currentRecycleFiles = data.files || [];
    selectedRecycleIds.clear();

    const countText = document.getElementById('recycleCountText');
    const sizeText = document.getElementById('recycleSizeText');
    const tbody = document.getElementById('recycleTableBody');

    let totalBytes = 0;
    currentRecycleFiles.forEach(f => totalBytes += (f.size || 0));

    if (countText) countText.textContent = currentRecycleFiles.length;
    if (sizeText) sizeText.textContent = formatBytes(totalBytes);

    updateRecycleBulkBar();

    if (!currentRecycleFiles || currentRecycleFiles.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-muted">A lomtár jelenleg üres</td></tr>';
      return;
    }

    tbody.innerHTML = currentRecycleFiles.map(f => `
      <tr>
        <td><input type="checkbox" class="recycle-chk" value="${f.id}" onchange="onRecycleChkChange(this)"></td>
        <td><strong>📄 ${f.name}</strong></td>
        <td><span class="badge badge-purple">${f.share}</span></td>
        <td><code>${f.originalPath}</code></td>
        <td>${formatBytes(f.size)}</td>
        <td><small>${new Date(f.deletedAt).toLocaleString('hu-HU')}</small></td>
        <td>
          <div class="flex-gap">
            <button class="btn btn-ghost btn-sm" onclick="restoreRecycleFile('${f.id}')">Visszaállítás</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteRecycleFile('${f.id}')">Törlés</button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    toast('Hiba a lomtár betöltésekor', 'error');
  }
}

function onRecycleChkChange(chk) {
  if (chk.checked) selectedRecycleIds.add(chk.value);
  else selectedRecycleIds.delete(chk.value);
  updateRecycleBulkBar();
}

function toggleSelectAllRecycle(masterChk) {
  const chks = document.querySelectorAll('.recycle-chk');
  chks.forEach(c => {
    c.checked = masterChk.checked;
    if (masterChk.checked) selectedRecycleIds.add(c.value);
    else selectedRecycleIds.delete(c.value);
  });
  updateRecycleBulkBar();
}

function updateRecycleBulkBar() {
  const bar = document.getElementById('recycleBulkBar');
  const countEl = document.getElementById('recycleSelectedCount');
  if (selectedRecycleIds.size > 0) {
    bar.style.display = '';
    countEl.textContent = selectedRecycleIds.size;
  } else {
    bar.style.display = 'none';
  }
}

async function bulkRestoreRecycle() {
  if (selectedRecycleIds.size === 0) return;
  try {
    const ids = Array.from(selectedRecycleIds);
    await apiPost('/api/recycle/bulk-restore', { ids });
    toast(`${ids.length} fájl visszaállítva!`, 'success');
    loadRecycleFiles();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

async function bulkDeleteRecycle() {
  if (selectedRecycleIds.size === 0) return;
  if (!confirm(`Biztosan törölni szeretnéd a kijelölt ${selectedRecycleIds.size} fájlt a lomtárból?`)) return;

  try {
    const ids = Array.from(selectedRecycleIds);
    await apiPost('/api/recycle/bulk-delete', { ids });
    toast(`${ids.length} fájl törölve!`, 'success');
    loadRecycleFiles();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

async function restoreRecycleFile(id) {
  try {
    await apiPost(`/api/recycle/${id}/restore`);
    toast('Fájl visszaállítva!', 'success');
    loadRecycleFiles();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

async function deleteRecycleFile(id) {
  try {
    await apiDelete(`/api/recycle/${id}`);
    toast('Fájl véglegesen törölve!', 'success');
    loadRecycleFiles();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

function confirmEmptyRecycle() {
  document.getElementById('confirmTitle').textContent = 'Lomtár Kiürítése';
  document.getElementById('confirmText').textContent = 'Biztosan véglegesen törlöd az ÖSSZES lomtárban lévő fájlt?';
  document.getElementById('confirmBtn').onclick = async () => {
    try {
      await apiPost('/api/recycle/empty');
      toast('Lomtár kiürítve!', 'success');
      loadRecycleFiles();
    } catch (e) {
      toast('Hiba: ' + e.message, 'error');
    }
    closeModal('confirmModal');
  };
  document.getElementById('confirmModal').classList.add('open');
}

// =========================================================
// STORAGE & QUOTAS CONTROLLER
// =========================================================
async function loadStorage() {
  try {
    const data = await apiGet('/api/storage');

    // Share sizes table
    const sTbody = document.getElementById('shareSizesTableBody');
    if (sTbody) {
      if (!data.storage || !data.storage.shareSizes || data.storage.shareSizes.length === 0) {
        sTbody.innerHTML = '<tr><td colspan="3" class="text-muted">Nincsenek mappák a megfigyelt tárhelyen</td></tr>';
      } else {
        sTbody.innerHTML = data.storage.shareSizes.map(s => `
          <tr>
            <td><strong>📁 ${s.name}</strong></td>
            <td><code>${s.path}</code></td>
            <td><span class="badge badge-cyan">${s.size}</span></td>
          </tr>
        `).join('');
      }
    }

    // Users quota table
    const qTbody = document.getElementById('userQuotasTableBody');
    if (qTbody) {
      const usersData = await apiGet('/api/users').catch(() => ({ users: [] }));
      const users = usersData.users || [];
      const quotas = data.quotas || {};

      if (users.length === 0) {
        qTbody.innerHTML = '<tr><td colspan="3" class="text-muted">Nincsenek felhasználók</td></tr>';
      } else {
        qTbody.innerHTML = users.map(u => {
          const qLimit = quotas[u.username] || u.quotaMB || 0;
          return `
            <tr>
              <td><strong>👤 ${u.username}</strong></td>
              <td>${qLimit ? `<span class="badge badge-purple">${qLimit} MB</span>` : '<span class="text-muted">Korlátlan</span>'}</td>
              <td>
                <button class="btn btn-ghost btn-sm" onclick="openUserQuotaModal('${u.username}', ${qLimit})">Limit Módosítása</button>
              </td>
            </tr>
          `;
        }).join('');
      }
    }
  } catch (e) {
    toast('Hiba a tárhely adatok betöltésekor: ' + e.message, 'error');
  }
}

function openUserQuotaModal(username, currentLimit) {
  document.getElementById('quotaModalUser').textContent = `Felhasználó: ${username}`;
  document.getElementById('qModalLimit').value = currentLimit || 0;
  document.getElementById('quotaModal').dataset.username = username;
  document.getElementById('quotaModal').classList.add('open');
}

async function saveUserQuotaFromModal() {
  const username = document.getElementById('quotaModal').dataset.username;
  const limitMB = parseInt(document.getElementById('qModalLimit').value) || 0;
  if (!username) return;

  try {
    await apiPut(`/api/storage/quotas/${username}`, { limitMB });
    toast(`Kvóta beállítva ${username} számára: ${limitMB ? limitMB + ' MB' : 'Korlátlan'}`, 'success');
    closeModal('quotaModal');
    loadStorage();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

// =========================================================
// 10. SNAPSHOTS
// =========================================================
async function loadSnapshots() {
  try {
    const data = await apiGet('/api/snapshots');
    const tbody = document.getElementById('snapshotsTableBody');

    if (data.config) {
      if (document.getElementById('autoSnapEnabled')) document.getElementById('autoSnapEnabled').checked = !!data.config.enabled;
      if (document.getElementById('autoSnapInterval')) document.getElementById('autoSnapInterval').value = data.config.intervalHours || 24;
      if (document.getElementById('autoSnapMaxCount')) document.getElementById('autoSnapMaxCount').value = data.config.maxSnapshots || 10;
    }

    if (!data.snapshots || data.snapshots.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted">Nincsenek pillanatképek</td></tr>';
      return;
    }

    tbody.innerHTML = data.snapshots.map(s => `
      <tr>
        <td><strong>📸 ${s.name}</strong></td>
        <td><code>${s.path}</code></td>
        <td><small>${new Date(s.created).toLocaleString('hu-HU')}</small></td>
        <td><span class="badge badge-cyan">${s.size}</span></td>
        <td>
          <div class="flex-gap">
            <button class="btn btn-ghost btn-sm" onclick="confirmRestoreSnapshot('${s.id}')">Visszaállítás</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="confirmDeleteSnapshot('${s.id}')">Törlés</button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    toast('Hiba a pillanatképek betöltésekor', 'error');
  }
}

async function saveSnapshotSettings() {
  const body = {
    enabled: document.getElementById('autoSnapEnabled').checked,
    intervalHours: parseInt(document.getElementById('autoSnapInterval').value) || 24,
    maxSnapshots: parseInt(document.getElementById('autoSnapMaxCount').value) || 10
  };

  try {
    const res = await apiPut('/api/snapshots/config', body);
    toast(res.message || 'Automata snapshot beállítások elmentve!', 'success');
  } catch (e) {
    toast('Hiba a mentéskor: ' + e.message, 'error');
  }
}

// =========================================================
// PRINTERS & PRINTING CONTROLLER
// =========================================================
async function loadPrintersView() {
  try {
    const data = await apiGet('/api/printers');
    const tbody = document.getElementById('printersTableBody');
    const badge = document.getElementById('printerCountBadge');
    const select = document.getElementById('printerDefaultSelect');
    const cupsBanner = document.getElementById('cupsMissingBanner');
    const config = data.config || {};

    if (cupsBanner) {
      cupsBanner.style.display = data.cupsInstalled === false ? 'block' : 'none';
    }

    if (document.getElementById('printerServiceEnabled')) {
      document.getElementById('printerServiceEnabled').checked = !!config.enabled;
    }
    if (document.getElementById('printerFolderInterval')) {
      document.getElementById('printerFolderInterval').value = (config.folderPrint && config.folderPrint.checkIntervalSec) || 10;
    }

    const printers = data.printers || [];
    if (badge) badge.textContent = `${printers.length} Nyomtató`;

    if (select) {
      select.innerHTML = '<option value="">Rendszer alapértelmezett</option>' +
        printers.map(p => `<option value="${p.id || p.name}" ${(config.defaultPrinter === p.id || config.defaultPrinter === p.name) ? 'selected' : ''}>${p.name}</option>`).join('');
    }

    if (!printers || printers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-muted">Nem található felderített nyomtató. Kattints a "🔍 Wi-Fi / LAN Keresés" vagy "➕ IP Nyomtató Hozzáadása" gombra!</td></tr>';
      return;
    }

    tbody.innerHTML = printers.map(p => `
      <tr>
        <td><strong>🜁 ${p.name}</strong></td>
        <td><code>${p.ip ? p.ip + ':' + (p.port || 9100) : 'Helyi CUPS'}</code></td>
        <td><span class="badge ${p.status === 'Printing' ? 'badge-amber' : 'badge-green'}">${p.status}</span></td>
        <td>${(data.defaultPrinter === p.name || data.defaultPrinter === p.id) ? '<span class="badge badge-purple">Alapértelmezett</span>' : '—'}</td>
        <td>
          ${p.type !== 'cups' ? `<button class="btn btn-ghost btn-sm" style="color:var(--red);" onclick="deleteManualPrinter('${p.id || p.ip}')">Törlés</button>` : '<span class="text-muted">Rendszer</span>'}
        </td>
      </tr>
    `).join('');
  } catch (e) {
    toast('Hiba a nyomtatók betöltésekor: ' + e.message, 'error');
  }
}

async function scanNetworkPrintersUi() {
  try {
    toast('Wi-Fi / LAN hálózati nyomtatók keresése folyamatban...', 'info');
    const res = await apiPost('/api/printers/scan', {});
    const found = res.printers || [];
    if (found.length === 0) {
      toast('Nem található nyomtató az alhálózaton a 9100 / 631 porton. Próbáld meg kézzel megadni az IP címét!', 'info');
    } else {
      for (const p of found) {
        await apiPost('/api/printers/add-manual', p).catch(() => {});
      }
      toast(`${found.length} hálózati nyomtató felderítve és hozzáadva!`, 'success');
      loadPrintersView();
    }
  } catch (e) {
    toast('Keresési hiba: ' + e.message, 'error');
  }
}

function openAddManualPrinterModal() {
  document.getElementById('manualPrinterName').value = '';
  document.getElementById('manualPrinterIp').value = '';
  document.getElementById('manualPrinterPort').value = '9100';
  document.getElementById('addPrinterModal').classList.add('open');
}

async function saveManualPrinterFromModal() {
  const name = document.getElementById('manualPrinterName').value.trim();
  const ip = document.getElementById('manualPrinterIp').value.trim();
  const port = parseInt(document.getElementById('manualPrinterPort').value) || 9100;

  if (!ip) return toast('Kérlek add meg a nyomtató IP címét!', 'error');

  try {
    await apiPost('/api/printers/add-manual', { name, ip, port });
    toast('Hálózati nyomtató sikeresen hozzáadva!', 'success');
    closeModal('addPrinterModal');
    loadPrintersView();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

async function deleteManualPrinter(id) {
  try {
    await apiDelete(`/api/printers/manual/${id}`);
    toast('Hálózati nyomtató eltávolítva!', 'success');
    loadPrintersView();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

async function installCupsUi() {
  const modal = document.getElementById('installProgressModal');
  if (modal) modal.classList.add('open');

  updateProgressBar('installProgressBarFill', 'installProgressStatusText', 'installProgressPercentText', 10, 'Csomaglista frissítése (apt update)...');

  try {
    await new Promise(r => setTimeout(r, 500));
    updateProgressBar('installProgressBarFill', 'installProgressStatusText', 'installProgressPercentText', 35, 'CUPS nyomtatási illesztők letöltése & telepítése...');

    const resPromise = apiPost('/api/printers/install-cups', {});

    await new Promise(r => setTimeout(r, 1200));
    updateProgressBar('installProgressBarFill', 'installProgressStatusText', 'installProgressPercentText', 75, 'CUPS szolgáltatások elindítása & konfigurálása...');

    const res = await resPromise;

    updateProgressBar('installProgressBarFill', 'installProgressStatusText', 'installProgressPercentText', 100, 'CUPS telepítés sikeres!');
    await new Promise(r => setTimeout(r, 800));

    toast(res.message || 'CUPS nyomtató csomagok sikeresen telepítve!', 'success');
    loadPrintersView();
  } catch (e) {
    toast('Telepítési hiba: ' + e.message, 'error');
  } finally {
    if (modal) modal.classList.remove('open');
  }
}

async function savePrinterSettings() {
  const body = {
    enabled: document.getElementById('printerServiceEnabled').checked,
    defaultPrinter: document.getElementById('printerDefaultSelect').value,
    folderPrint: {
      enabled: document.getElementById('printerServiceEnabled').checked,
      monitoredFolder: '/srv/samba/Print/nyomtatas',
      archiveFolder: '/srv/samba/Print/archive',
      checkIntervalSec: parseInt(document.getElementById('printerFolderInterval').value) || 10
    }
  };

  try {
    const res = await apiPut('/api/printers/config', body);
    toast(res.message || 'Nyomtatási beállítások elmentve!', 'success');
    loadPrintersView();
  } catch (e) {
    toast('Hiba a mentéskor: ' + e.message, 'error');
  }
}

function openCreateSnapshotModal() {
  document.getElementById('snapModalName').value = '';
  document.getElementById('snapshotModal').classList.add('open');
}

async function saveSnapshotFromModal() {
  const name = document.getElementById('snapModalName').value.trim();
  try {
    await apiPost('/api/snapshots', { name });
    toast('Pillanatkép létrehozva!', 'success');
    closeModal('snapshotModal');
    loadSnapshots();
  } catch (e) {
    toast('Hiba: ' + e.message, 'error');
  }
}

function confirmRestoreSnapshot(id) {
  document.getElementById('confirmTitle').textContent = 'Pillanatkép Visszaállítása';
  document.getElementById('confirmText').textContent = `Biztosan visszaállítod a szervert a "${id}" pillanatkép állapotára? A jelenlegi fájlok felülíródnak!`;
  document.getElementById('confirmBtn').onclick = async () => {
    try {
      await apiPost(`/api/snapshots/${id}/restore`);
      toast('Pillanatkép visszaállítva!', 'success');
      loadSnapshots();
    } catch (e) {
      toast('Hiba: ' + e.message, 'error');
    }
    closeModal('confirmModal');
  };
  document.getElementById('confirmModal').classList.add('open');
}

function confirmDeleteSnapshot(id) {
  document.getElementById('confirmTitle').textContent = 'Pillanatkép Törlése';
  document.getElementById('confirmText').textContent = `Biztosan törlöd a "${id}" pillanatképet?`;
  document.getElementById('confirmBtn').onclick = async () => {
    try {
      await apiDelete(`/api/snapshots/${id}`);
      toast('Pillanatkép törölve!', 'success');
      loadSnapshots();
    } catch (e) {
      toast('Hiba: ' + e.message, 'error');
    }
    closeModal('confirmModal');
  };
  document.getElementById('confirmModal').classList.add('open');
}

// =========================================================
// 11. SAMBA CONFIGURATION GUI & RAW
// =========================================================
async function loadSambaGuiConfig() {
  try {
    const data = await apiGet('/api/samba-config');
    const s = data.settings || {};

    document.getElementById('cfgWorkgroup').value = s.workgroup || 'WORKGROUP';
    document.getElementById('cfgNetbiosName').value = s.netbiosName || 'NAS-SERVER';
    document.getElementById('cfgServerString').value = s.serverString || 'NAS Samba Server';
    document.getElementById('cfgMinProto').value = s.serverMinProtocol || 'SMB2_10';
    document.getElementById('cfgMaxProto').value = s.serverMaxProtocol || 'SMB3_11';
    document.getElementById('cfgGuestOk').value = s.guestOk || 'yes';
    document.getElementById('cfgEncrypt').value = s.smbEncrypt || 'auto';

    document.getElementById('rawConfigTextarea').value = data.rawContent || '';
  } catch (e) {
    toast('Hiba a Samba beállítások betöltésekor', 'error');
  }
}

async function saveSambaGuiSettings() {
  const body = {
    workgroup: document.getElementById('cfgWorkgroup').value.trim(),
    netbiosName: document.getElementById('cfgNetbiosName').value.trim(),
    serverString: document.getElementById('cfgServerString').value.trim(),
    serverMinProtocol: document.getElementById('cfgMinProto').value,
    serverMaxProtocol: document.getElementById('cfgMaxProto').value,
    guestOk: document.getElementById('cfgGuestOk').value,
    smbEncrypt: document.getElementById('cfgEncrypt').value
  };

  try {
    await apiPut('/api/samba-config', body);
    toast('Samba globális beállítások frissítve!', 'success');
    loadSambaGuiConfig();
  } catch (e) {
    toast('Hiba a mentéskor: ' + e.message, 'error');
  }
}

// =========================================================
// 12. SYSTEM SETTINGS & IMPORT/EXPORT
// =========================================================
async function loadSettings() {
  try {
    await checkAppVersion(false);
    const data = await apiGet('/api/settings');
  } catch (e) {}
  // Auto-load changelog, releases & notification settings
  loadChangelog();
  loadReleasesList();
  loadNotificationSettings();
}

async function loadNotificationSettings() {
  try {
    const res = await apiGet('/api/notifications/config');
    const cfg = res.config || {};

    if (cfg.discord) {
      document.getElementById('notifDiscordEnabled').checked = !!cfg.discord.enabled;
      document.getElementById('notifDiscordUrl').value = cfg.discord.webhookUrl || '';
    }

    if (cfg.smtp) {
      document.getElementById('notifSmtpEnabled').checked = !!cfg.smtp.enabled;
      document.getElementById('notifSmtpHost').value = cfg.smtp.host || '';
      document.getElementById('notifSmtpPort').value = cfg.smtp.port || 587;
      document.getElementById('notifSmtpUser').value = cfg.smtp.user || '';
      document.getElementById('notifSmtpPass').value = cfg.smtp.pass || '';
      document.getElementById('notifSmtpFrom').value = cfg.smtp.fromEmail || '';
      document.getElementById('notifSmtpTo').value = cfg.smtp.toEmail || '';
      document.getElementById('notifSmtpSecure').checked = !!cfg.smtp.secure;
    }

    if (cfg.events) {
      document.getElementById('notifEventUsers').checked = cfg.events.userChanges !== false;
      document.getElementById('notifEventShares').checked = cfg.events.shareChanges !== false;
      document.getElementById('notifEventService').checked = cfg.events.serviceAlerts !== false;
      document.getElementById('notifEventStorage').checked = cfg.events.storageAlerts !== false;
    }
  } catch (e) {
    console.error('Notification settings load error:', e);
  }
}

async function saveNotificationSettings() {
  const body = {
    discord: {
      enabled: document.getElementById('notifDiscordEnabled').checked,
      webhookUrl: document.getElementById('notifDiscordUrl').value.trim()
    },
    smtp: {
      enabled: document.getElementById('notifSmtpEnabled').checked,
      host: document.getElementById('notifSmtpHost').value.trim(),
      port: parseInt(document.getElementById('notifSmtpPort').value) || 587,
      user: document.getElementById('notifSmtpUser').value.trim(),
      pass: document.getElementById('notifSmtpPass').value,
      fromEmail: document.getElementById('notifSmtpFrom').value.trim(),
      toEmail: document.getElementById('notifSmtpTo').value.trim(),
      secure: document.getElementById('notifSmtpSecure').checked
    },
    events: {
      userChanges: document.getElementById('notifEventUsers').checked,
      shareChanges: document.getElementById('notifEventShares').checked,
      serviceAlerts: document.getElementById('notifEventService').checked,
      storageAlerts: document.getElementById('notifEventStorage').checked
    }
  };

  try {
    const res = await apiPut('/api/notifications/config', body);
    toast(res.message || 'Értesítési beállítások elmentve!', 'success');
  } catch (e) {
    toast('Hiba a mentéskor: ' + e.message, 'error');
  }
}

async function sendTestNotification() {
  try {
    toast('Teszt értesítés küldése folyamatban...', 'info');
    const res = await apiPost('/api/notifications/test', {});
    toast(res.message || 'Teszt értesítés elküldve!', 'success');
  } catch (e) {
    toast('Értesítési hiba: ' + e.message, 'error');
  }
}

// =========================================================
// 13. VERSION CONTROL & GITHUB AUTO-UPDATE
// =========================================================
async function checkAppVersion(showToast = false) {
  try {
    const data = await apiGet('/api/version/check');

    const topChip = document.getElementById('topVersionText');
    if (topChip) topChip.textContent = `v${data.currentVersion}`;

    if (document.getElementById('verCurrentText')) document.getElementById('verCurrentText').textContent = `v${data.currentVersion}`;
    if (document.getElementById('verCommitText')) document.getElementById('verCommitText').textContent = data.currentCommit || 'unknown';
    if (document.getElementById('verLatestText')) document.getElementById('verLatestText').textContent = data.latestVersion ? `v${data.latestVersion} (${data.latestCommit})` : '—';
    if (document.getElementById('verCommitMsg')) document.getElementById('verCommitMsg').textContent = data.commitMessage || 'Naprakész verzió';
    if (document.getElementById('verPublishedAt')) {
      document.getElementById('verPublishedAt').textContent = data.publishedAt
        ? new Date(data.publishedAt).toLocaleString('hu-HU')
        : '—';
    }

    const badge = document.getElementById('versionStatusBadge');
    const applyBtn = document.getElementById('verApplyBtn');

    if (data.hasUpdate) {
      if (badge) {
        badge.className = 'badge badge-amber';
        badge.textContent = '🎉 Új verzió érhető el!';
      }
      if (applyBtn) applyBtn.style.display = '';
      if (topChip) {
        topChip.parentNode.style.background = 'rgba(245,158,11,0.2)';
        topChip.parentNode.style.borderColor = 'rgba(245,158,11,0.5)';
        topChip.textContent = `🎉 Új: v${data.latestVersion}`;
      }
      if (showToast) toast(`Új verzió érhető el a GitHubon: v${data.latestVersion}!`, 'info');
    } else {
      if (badge) {
        badge.className = 'badge badge-green';
        badge.textContent = '✓ Naprakész';
      }
      if (applyBtn) applyBtn.style.display = 'none';
      if (topChip) {
        topChip.parentNode.style.background = 'rgba(139,92,246,0.12)';
        topChip.parentNode.style.borderColor = 'rgba(139,92,246,0.3)';
      }
      if (showToast) toast('Az alkalmazás naprakész!', 'success');
    }

  } catch (e) {
    if (showToast) toast('Verzió-ellenőrzési hiba: ' + e.message, 'error');
  }
}

async function applyAppUpdate() {
  if (!confirm('Biztosan frissíteni szeretnéd a rendszert a GitHub legújabb verziójára?')) return;
  try {
    toast('Frissítés indítása... A rendszer hamarosan újraindul.', 'info');
    const res = await apiPost('/api/version/update');
    toast(res.message || 'Frissítés sikeres!', 'success');
    setTimeout(() => {
      location.reload();
    }, 4000);
  } catch (e) {
    toast('Frissítési hiba: ' + e.message, 'error');
  }
}

async function loadChangelog() {
  const tbody = document.getElementById('changelogTableBody');
  tbody.innerHTML = '<tr><td colspan="4" class="text-muted">Betöltés...</td></tr>';

  try {
    const data = await apiGet('/api/version/changelog?limit=20');
    const changelog = data.changelog || [];

    if (changelog.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-muted">Nincsenek commit-ok</td></tr>';
      return;
    }

    tbody.innerHTML = changelog.map(c => `
      <tr>
        <td><code style="font-size:0.8rem;">${c.sha}</code></td>
        <td><strong>${escapeHtml(c.message.split('\n')[0])}</strong></td>
        <td>${escapeHtml(c.author)}</td>
        <td><small>${c.date ? new Date(c.date).toLocaleString('hu-HU') : '—'}</small></td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-muted">Hiba a changelog betöltésekor: ' + e.message + '</td></tr>';
  }
}

async function loadReleasesList() {
  const container = document.getElementById('releasesListContainer');
  container.innerHTML = '<p class="text-muted">Betöltés...</p>';

  try {
    const data = await apiGet('/api/version/releases');
    const releases = data.releases || [];

    if (releases.length === 0) {
      container.innerHTML = '<p class="text-muted">Nincsenek GitHub release-ek.</p>';
      return;
    }

    container.innerHTML = releases.map(r => `
      <div class="card mb-12" style="background:var(--bg-input);border-color:${r.prerelease ? 'rgba(245,158,11,0.3)' : 'rgba(34,197,94,0.3)'};">
        <div class="card-header-flex">
          <div>
            <h4 style="margin:0;">🏷️ ${escapeHtml(r.name || r.tag)}</h4>
            <small class="text-muted">${r.publishedAt ? new Date(r.publishedAt).toLocaleString('hu-HU') : '—'}</small>
          </div>
          <div class="flex-gap">
            ${r.prerelease ? '<span class="badge badge-amber">Pre-release</span>' : '<span class="badge badge-green">Stabil</span>'}
            ${r.url ? `<a href="${r.url}" target="_blank" class="btn btn-ghost btn-sm">Megnyitás ↗</a>` : ''}
          </div>
        </div>
        ${r.body ? `<div class="mt-8 text-muted" style="white-space:pre-wrap;font-size:0.85rem;">${escapeHtml(r.body)}</div>` : ''}
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = '<p class="text-muted">Hiba a release-ek betöltésekor: ' + e.message + '</p>';
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// Initial version check
setTimeout(() => { checkAppVersion(false); }, 1500);

function triggerImportConfig() {
  document.getElementById('importFileInput').click();
}

async function handleImportConfig(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const parsed = JSON.parse(evt.target.result);
      await apiPost('/api/settings/import', parsed);
      toast('Konfiguráció sikeresen importálva!', 'success');
      switchSection('dashboard');
    } catch (err) {
      toast('Importálási hiba: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

// Format bytes helper
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// =========================================================
// AUTHENTICATION & SETUP CONTROLLER
// =========================================================
let currentAuthStatus = { setupCompleted: false, authenticated: false, username: null, storageBasePath: '/srv/samba' };

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status', { headers: getAuthHeaders() });
    const data = await res.json();
    currentAuthStatus = data;

    const setupOverlay = document.getElementById('setupOverlay');
    const loginOverlay = document.getElementById('loginOverlay');
    const settingsPathInput = document.getElementById('settingsStoragePath');

    if (settingsPathInput && data.storageBasePath) {
      settingsPathInput.value = data.storageBasePath;
    }

    if (!data.setupCompleted) {
      if (setupOverlay) setupOverlay.style.display = 'flex';
      if (loginOverlay) loginOverlay.style.display = 'none';
      return false;
    }

    if (!data.authenticated) {
      if (setupOverlay) setupOverlay.style.display = 'none';
      if (loginOverlay) loginOverlay.style.display = 'flex';
      return false;
    }

    // Authenticated
    if (setupOverlay) setupOverlay.style.display = 'none';
    if (loginOverlay) loginOverlay.style.display = 'none';

    if (document.getElementById('topUserName')) document.getElementById('topUserName').textContent = data.username || 'Admin';
    if (document.getElementById('topUserAvatar')) document.getElementById('topUserAvatar').textContent = (data.username || 'A').charAt(0).toUpperCase();

    refreshDashboard();
    return true;
  } catch (e) {
    console.error('Auth status check error:', e);
    return false;
  }
}

function updateProgressBar(fillId, statusId, percentId, percent, statusText) {
  const fill = document.getElementById(fillId);
  const status = document.getElementById(statusId);
  const perc = document.getElementById(percentId);

  if (fill) fill.style.width = `${percent}%`;
  if (status && statusText) status.textContent = statusText;
  if (perc) perc.textContent = `${percent}%`;
}

async function handleSetupSubmit(e) {
  e.preventDefault();
  const username = document.getElementById('setupUsername').value.trim();
  const password = document.getElementById('setupPassword').value;
  const passwordConfirm = document.getElementById('setupPasswordConfirm').value;
  const storageBasePath = document.getElementById('setupStoragePath').value.trim() || '/srv/samba';

  if (password !== passwordConfirm) {
    return toast('A megadott jelszavak nem egyeznek!', 'error');
  }

  const pBox = document.getElementById('setupProgressBox');
  const btn = document.getElementById('setupSubmitBtn');

  if (pBox) pBox.style.display = 'block';
  if (btn) btn.disabled = true;

  updateProgressBar('setupProgressBarFill', 'setupProgressStatusText', 'setupProgressPercentText', 15, 'Rendszerbeállítások ellenőrzése...');

  try {
    await new Promise(r => setTimeout(r, 400));
    updateProgressBar('setupProgressBarFill', 'setupProgressStatusText', 'setupProgressPercentText', 45, 'Adminisztrátori fiók & biztonsági kulcs generálása...');

    const res = await apiPost('/api/auth/setup', { username, password, storageBasePath });

    updateProgressBar('setupProgressBarFill', 'setupProgressStatusText', 'setupProgressPercentText', 85, 'Tárhely könyvtár inicializálása...');
    await new Promise(r => setTimeout(r, 400));

    if (res.token) {
      localStorage.setItem('nas_auth_token', res.token);
    }

    updateProgressBar('setupProgressBarFill', 'setupProgressStatusText', 'setupProgressPercentText', 100, 'Telepítés sikeres! Bejelentkezés...');
    await new Promise(r => setTimeout(r, 600));

    toast('SambaHub sikeresen telepítve és konfigurálva!', 'success');
    await checkAuthStatus();
  } catch (err) {
    toast('Telepítési hiba: ' + err.message, 'error');
  } finally {
    if (pBox) pBox.style.display = 'none';
    if (btn) btn.disabled = false;
  }
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;

  try {
    const res = await apiPost('/api/auth/login', { username, password });
    if (res.token) {
      localStorage.setItem('nas_auth_token', res.token);
    }
    toast('Sikeres bejelentkezés!', 'success');
    await checkAuthStatus();
  } catch (err) {
    toast('Bejelentkezési hiba: ' + err.message, 'error');
  }
}

async function logoutApp() {
  try {
    await apiPost('/api/auth/logout').catch(() => {});
  } catch (e) {}
  localStorage.removeItem('nas_auth_token');
  toast('Kijelentkezve!', 'info');
  await checkAuthStatus();
}

async function saveStoragePathFromSettings() {
  const pathInput = document.getElementById('settingsStoragePath');
  const storageBasePath = pathInput ? pathInput.value.trim() : '';

  if (!storageBasePath) {
    return toast('Kérlek add meg a megfigyelt tárhely útvonalát!', 'error');
  }

  try {
    await apiPut('/api/auth/storage-path', { storageBasePath });
    toast('Megfigyelt tárhely útvonala sikeresen elmentve!', 'success');
    refreshDashboard();
  } catch (e) {
    toast('Hiba a mentéskor: ' + e.message, 'error');
  }
}

// Global search bar
document.getElementById('globalSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) return;
});

// Auto-refresh interval & initial auth check
checkAuthStatus();
setInterval(() => {
  if (currentAuthStatus.authenticated) {
    if (currentSection === 'dashboard') refreshDashboard();
    else if (currentSection === 'connections') loadConnections();
  }
}, 15000);
