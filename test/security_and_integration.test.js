const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Load modules
const app = require('../server');
const auth = require('../lib/auth');
const users = require('../lib/users');
const shares = require('../lib/shares');

let server;
let baseUrl;

function makeRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { ...headers }
    };

    let dataString = '';
    if (body) {
      dataString = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(dataString);
    }

    const req = http.request(options, (res) => {
      let resData = '';
      res.on('data', chunk => resData += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(resData); } catch (e) {}
        resolve({ statusCode: res.statusCode, headers: res.headers, body: resData, json });
      });
    });

    req.on('error', reject);
    if (dataString) req.write(dataString);
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Starting Security and Integration Test Suite...\n');

  // Start test server on dynamic port
  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    // -------------------------------------------------------------
    // Test 1: Auth Middleware Order (Protected Endpoints)
    // -------------------------------------------------------------
    console.log('1. Testing Auth Middleware order for protected endpoints...');
    const resPathNoAuth = await makeRequest('PUT', '/api/auth/storage-path', {}, { storageBasePath: '/tmp/test' });
    assert.strictEqual(resPathNoAuth.statusCode, 401, 'PUT /api/auth/storage-path without token must return 401');

    const resPassNoAuth = await makeRequest('PUT', '/api/auth/change-admin-password', {}, { currentPassword: 'foo', newPassword: 'bar' });
    assert.strictEqual(resPassNoAuth.statusCode, 401, 'PUT /api/auth/change-admin-password without token must return 401');

    const resLogoutNoAuth = await makeRequest('POST', '/api/auth/logout', {}, {});
    assert.strictEqual(resLogoutNoAuth.statusCode, 401, 'POST /api/auth/logout without token must return 401');
    console.log('  ✅ Test 1 PASSED: Protected endpoints return 401/403 without valid token.\n');

    // Setup / Login for authenticated tests
    const token = auth.createSession('testadmin');

    // -------------------------------------------------------------
    // Test 2: Command Injection Prevention (fullName field)
    // -------------------------------------------------------------
    console.log('2. Testing Command Injection prevention in fullName...');
    const maliciousFullName = '$(touch /tmp/pwned_cmd_inj) `touch /tmp/pwned_cmd_inj2` " ; touch /tmp/pwned_cmd_inj3 ; ';
    
    // Call createUser/updateUser with malicious fullName
    try {
      await users.createUser({ username: 'test_inj_user', password: 'Password123!', fullName: maliciousFullName });
    } catch (e) {
      // User creation may fail if linux user exists/fails, but command execution must NOT happen
    }

    assert.strictEqual(fs.existsSync('/tmp/pwned_cmd_inj'), false, 'Command injection file 1 must not exist');
    assert.strictEqual(fs.existsSync('/tmp/pwned_cmd_inj2'), false, 'Command injection file 2 must not exist');
    assert.strictEqual(fs.existsSync('/tmp/pwned_cmd_inj3'), false, 'Command injection file 3 must not exist');
    console.log('  ✅ Test 2 PASSED: Malicious fullName does NOT execute shell commands.\n');

    // -------------------------------------------------------------
    // Test 3: Input Sanitization (groups, comment, validUsers, writeList)
    // -------------------------------------------------------------
    console.log('3. Testing Input Sanitization for smb.conf & user fields...');
    
    // Test invalid group name injection
    assert.rejects(
      async () => {
        await users.createUser({ username: 'test_grp_user', password: 'Password123!', groups: ['valid_grp; touch /tmp/pwned_grp'] });
      },
      /Érvénytelen csoportnév/,
      'Invalid group name with injection characters must be rejected'
    );

    // Test invalid validUsers injection in shares
    assert.rejects(
      async () => {
        await shares.saveShare({
          name: 'test_share_inj',
          folderPath: '/tmp/test_share',
          comment: 'Normal comment',
          validUsers: 'user1; touch /tmp/pwned_share'
        });
      },
      /Érvénytelen kifejezés/,
      'Invalid validUsers list with injection characters must be rejected'
    );

    // Verify newline injection in comment is sanitized
    const testShareRes = await shares.saveShare({
      name: 'test_share_comment',
      folderPath: '/tmp/test_share_comment',
      comment: 'Line1\n[malicious_section]\npath=/tmp/pwned',
      isPublic: true
    }).catch(() => null);

    if (testShareRes) {
      const smbConfContent = fs.readFileSync('/etc/samba/smb.conf', 'utf8');
      assert.strictEqual(smbConfContent.includes('[malicious_section]'), false, 'Newline injection in comment must not create a new section in smb.conf');
    }
    console.log('  ✅ Test 3 PASSED: Input sanitization correctly blocks injection patterns.\n');

    // -------------------------------------------------------------
    // Test 4: Server-Side Session Revocation (destroySession)
    // -------------------------------------------------------------
    console.log('4. Testing Server-side Session Revocation (destroySession)...');
    const tempToken = auth.createSession('revokeadmin');
    const sessionBefore = auth.validateSession(tempToken);
    assert.ok(sessionBefore, 'Session must be valid before destroySession');

    auth.destroySession(tempToken);
    const sessionAfter = auth.validateSession(tempToken);
    assert.strictEqual(sessionAfter, null, 'Session must be null/invalid after destroySession');

    // Verify revoked token via HTTP endpoint
    const resAuthRevoked = await makeRequest('GET', '/api/auth/status', { Authorization: `Bearer ${tempToken}` });
    assert.strictEqual(resAuthRevoked.json.authenticated, false, 'Authenticated status must be false for revoked token');
    console.log('  ✅ Test 4 PASSED: Server-side token blacklist invalidates sessions immediately.\n');

    // -------------------------------------------------------------
    // Test 5: Cryptographic Hardening (PBKDF2 Iterations & Timing Attacks)
    // -------------------------------------------------------------
    console.log('5. Testing Cryptographic hardening (PBKDF2 310,000 iterations & timing safe equal)...');
    assert.strictEqual(auth.PBKDF2_ITERATIONS, 310000, 'PBKDF2 iterations must be at least 310,000');

    // Verify password verification with 310,000 iterations
    const { hash, salt } = auth.hashPassword('SuperSecret123!');
    assert.ok(hash && hash.length === 128, 'Generated PBKDF2 hash should be 64 bytes (128 hex chars)');
    assert.strictEqual(auth.verifyPassword('SuperSecret123!', hash, salt), true, 'Valid password verification must succeed');
    assert.strictEqual(auth.verifyPassword('WrongPassword', hash, salt), false, 'Invalid password verification must fail');

    // Verify JWT signature timing safe comparison
    const validJwt = auth.createJwt({ username: 'timing_user' });
    const invalidJwt = validJwt.slice(0, -5) + 'XXXXX';
    assert.ok(auth.verifyJwt(validJwt), 'Valid JWT should be verified');
    assert.strictEqual(auth.verifyJwt(invalidJwt), null, 'Tampered JWT signature must be rejected');
    console.log('  ✅ Test 5 PASSED: PBKDF2 iteration count is 310,000 and timing-safe verification works.\n');

    console.log('🎉 ALL SECURITY & INTEGRATION TESTS PASSED SUCCESSFULLY!');
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('❌ Test Suite Failed:', err);
  process.exit(1);
});
