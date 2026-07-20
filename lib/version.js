const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { logEvent } = require('./audit');

const GITHUB_REPO = 'csuszy/smb_managger';
const ROOT_DIR = path.resolve(__dirname, '..');
const TOKEN_FILE = path.join(ROOT_DIR, 'data', 'github_token.json');

function run(cmd, cwd = ROOT_DIR) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, message: stderr || err.message, stdout });
      else resolve(stdout.trim());
    });
  });
}

function getToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      return (parsed.token || '').trim();
    }
  } catch (e) {}
  return '';
}

function fetchHttpsJson(url, method = 'GET', postData = null) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    const headers = {
      'User-Agent': 'SMB-Manager-App',
      'Accept': 'application/vnd.github.v3+json'
    };
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }
    if (postData) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`GitHub API hiba: HTTP ${res.statusCode} — ${data.substring(0, 200)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Érvénytelen JSON válasz a GitHub API-tól'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Időtúllépés a GitHub API csatlakozáskor'));
    });
    if (postData) req.write(postData);
    req.end();
  });
}

// ============================================
// VERSION CHECK
// ============================================
async function checkVersion() {
  let currentVersion = '2.0.0';
  let currentCommit = 'unknown';

  // Read local version
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    currentVersion = pkg.version || '2.0.0';
  } catch (e) {}

  // Read local commit
  try {
    currentCommit = await run('git rev-parse --short HEAD');
  } catch (e) {}

  let latestVersion = currentVersion;
  let latestCommit = currentCommit;
  let hasUpdate = false;
  let commitMessage = '';
  let publishedAt = '';
  let releaseNotes = '';
  let releaseUrl = '';

  try {
    // 1. Check latest release first
    try {
      const releaseData = await fetchHttpsJson(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
      );
      if (releaseData && releaseData.tag_name) {
        latestVersion = releaseData.tag_name.replace(/^v/, '');
        releaseNotes = releaseData.body || '';
        releaseUrl = releaseData.html_url || '';
        publishedAt = releaseData.published_at || '';
      }
    } catch (e) {
      // No releases yet — fall back to package.json from repo
      try {
        const remotePkgUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/package.json`;
        const remotePkgData = await fetchHttpsJson(remotePkgUrl);
        if (remotePkgData && remotePkgData.content) {
          const rawContent = Buffer.from(remotePkgData.content, 'base64').toString('utf8');
          const parsedPkg = JSON.parse(rawContent);
          if (parsedPkg && parsedPkg.version) latestVersion = parsedPkg.version;
        }
      } catch (e2) {}
    }

    // 2. Get latest commit info
    try {
      const remoteCommitsData = await fetchHttpsJson(
        `https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=1`
      );
      if (Array.isArray(remoteCommitsData) && remoteCommitsData.length > 0) {
        const topCommit = remoteCommitsData[0];
        latestCommit = topCommit.sha ? topCommit.sha.substring(0, 7) : currentCommit;
        if (topCommit.commit) {
          commitMessage = topCommit.commit.message || '';
          if (!publishedAt && topCommit.commit.author) {
            publishedAt = topCommit.commit.author.date || '';
          }
        }
      }
    } catch (e) {}

    // 3. Determine if update available
    if (compareVersions(latestVersion, currentVersion) > 0) {
      hasUpdate = true;
    } else if (currentCommit !== 'unknown' && currentCommit !== latestCommit) {
      hasUpdate = true;
    }

  } catch (e) {
    console.error('GitHub verzió-ellenőrzési hiba:', e.message);
  }

  return {
    currentVersion,
    currentCommit,
    latestVersion,
    latestCommit,
    hasUpdate,
    commitMessage,
    publishedAt,
    releaseNotes,
    releaseUrl,
    repoUrl: `https://github.com/${GITHUB_REPO}`
  };
}

// ============================================
// GET CHANGELOG (commits between versions)
// ============================================
async function getChangelog(limit = 20) {
  try {
    const commits = await fetchHttpsJson(
      `https://api.github.com/repos/${GITHUB_REPO}/commits?per_page=${limit}`
    );
    if (!Array.isArray(commits)) return [];
    return commits.map(c => ({
      sha: c.sha ? c.sha.substring(0, 7) : '',
      message: c.commit ? c.commit.message : '',
      author: c.commit && c.commit.author ? c.commit.author.name : 'Unknown',
      date: c.commit && c.commit.author ? c.commit.author.date : ''
    }));
  } catch (e) {
    return [];
  }
}

// ============================================
// GET ALL RELEASES
// ============================================
async function getReleases() {
  try {
    const releases = await fetchHttpsJson(
      `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`
    );
    if (!Array.isArray(releases)) return [];
    return releases.map(r => ({
      id: r.id,
      tag: r.tag_name,
      name: r.name || r.tag_name,
      body: r.body || '',
      publishedAt: r.published_at || r.created_at,
      url: r.html_url,
      prerelease: r.prerelease || false,
      draft: r.draft || false
    }));
  } catch (e) {
    return [];
  }
}

// ============================================
// APPLY UPDATE (git pull)
// ============================================
async function applySystemUpdate(adminUser = 'admin') {
  const token = getToken();

  try {
    // Detect current branch
    let currentBranch = 'main';
    try {
      currentBranch = await run('git rev-parse --abbrev-ref HEAD');
    } catch (e) {}

    // Stash any local changes
    try {
      await run('git stash 2>&1');
    } catch (e) {}

    // Pull from remote
    if (token) {
      await run(`git pull https://${token}@github.com/${GITHUB_REPO}.git ${currentBranch} 2>&1`);
    } else {
      await run(`git pull origin ${currentBranch} 2>&1`);
    }

    // Install dependencies
    await run('npm install --production 2>&1');

    logEvent('system', 'Rendszer sikeresen frissítve a GitHub legújabb verziójára', adminUser);

    // Restart service asynchronously
    setTimeout(() => {
      run('systemctl restart smb-manager 2>/dev/null').catch(() => {});
    }, 2000);

    return { success: true, message: 'A frissítés sikeresen megtörtént! Az alkalmazás újraindul...' };
  } catch (e) {
    // Try to restore stash on failure
    try { await run('git stash pop 2>&1'); } catch (e2) {}
    throw new Error('Frissítési hiba: ' + (e.message || JSON.stringify(e)));
  }
}

// ============================================
// CREATE RELEASE (push current state as a tag)
// ============================================
async function createRelease(tagName, releaseName, body = '', prerelease = false) {
  const token = getToken();
  if (!token) throw new Error('GitHub token szükséges a release létrehozásához!');

  // Get current HEAD sha
  let sha = '';
  try {
    sha = await run('git rev-parse HEAD');
  } catch (e) {
    throw new Error('Nem sikerült a jelenlegi commit SHA lekérdezése');
  }

  const postData = JSON.stringify({
    tag_name: tagName,
    target_commitish: sha,
    name: releaseName || tagName,
    body: body || `Release ${tagName}`,
    draft: false,
    prerelease: prerelease
  });

  const result = await fetchHttpsJson(
    `https://api.github.com/repos/${GITHUB_REPO}/releases`,
    'POST',
    postData
  );

  logEvent('system', `Új GitHub release létrehozva: ${tagName}`, 'admin');

  return {
    success: true,
    id: result.id,
    tag: result.tag_name,
    url: result.html_url,
    message: `Release ${tagName} sikeresen létrehozva!`
  };
}

// ============================================
// PUSH TO GITHUB
// ============================================
async function pushToGitHub(commitMessage = 'Update from SMB Manager') {
  const token = getToken();
  if (!token) throw new Error('GitHub token szükséges a push-oláshoz!');

  try {
    // Detect current branch
    let currentBranch = 'main';
    try {
      currentBranch = await run('git rev-parse --abbrev-ref HEAD');
    } catch (e) {}

    // Stage all changes
    await run('git add -A 2>&1');

    // Check if there are changes to commit
    let hasChanges = false;
    try {
      await run('git diff --cached --quiet');
    } catch (e) {
      hasChanges = true;
    }

    if (hasChanges) {
      await run(`git commit -m "${commitMessage.replace(/"/g, '\\"')}" 2>&1`);
    }

    // Push
    await run(`git push https://${token}@github.com/${GITHUB_REPO}.git ${currentBranch} 2>&1`);

    logEvent('system', `Kód push-olva a GitHub-ra: ${commitMessage}`, 'admin');

    return { success: true, message: 'Sikeresen push-olva a GitHub-ra!' };
  } catch (e) {
    throw new Error('Push hiba: ' + (e.message || JSON.stringify(e)));
  }
}

// ============================================
// HELPER: Semantic version comparison
// ============================================
function compareVersions(a, b) {
  const pa = (a || '0.0.0').replace(/^v/, '').split('.').map(Number);
  const pb = (b || '0.0.0').replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

module.exports = {
  checkVersion,
  getChangelog,
  getReleases,
  applySystemUpdate,
  createRelease,
  pushToGitHub
};
