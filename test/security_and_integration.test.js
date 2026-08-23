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
    // -------------------------------------------------------------
    // Test 6: Printers, Default Selection & Test Printing
    // -------------------------------------------------------------
    console.log('6. Testing Printer discovery, CUPS default selection & Test printing...');
    const printersModule = require('../lib/printers');
    
    // Test printer discovery
    const printerInfo = await printersModule.getPrinters();
    assert.ok(Array.isArray(printerInfo.printers), 'getPrinters must return a printers array');
    
    // Add temporary test printer
    const addRes = await printersModule.addManualPrinter({ name: 'Test Printer Unit', ip: '192.168.1.250', port: 9100, type: 'raw' });
    assert.strictEqual(addRes.success, true, 'addManualPrinter should return success: true');
    assert.strictEqual(addRes.printer.id, 'net_192_168_1_250', 'Printer ID should be net_192_168_1_250');

    // Save default printer selection
    printersModule.savePrinterConfig({ defaultPrinter: 'net_192_168_1_250' });
    const updatedInfo = await printersModule.getPrinters();
    assert.strictEqual(updatedInfo.defaultPrinter, 'net_192_168_1_250', 'Default printer must be updated in printer info');

    // Test print page endpoint via API
    const testPrintHttpRes = await makeRequest('POST', '/api/printers/test-print', { Authorization: `Bearer ${token}` }, { printerId: 'net_192_168_1_250' });
    assert.strictEqual(testPrintHttpRes.statusCode, 200, 'POST /api/printers/test-print should return HTTP 200');
    assert.strictEqual(testPrintHttpRes.json.success, true, 'test-print should return success: true');

    // Test print logs API
    const logsRes = await makeRequest('GET', '/api/printers/logs', { Authorization: `Bearer ${token}` });
    assert.strictEqual(logsRes.statusCode, 200, 'GET /api/printers/logs should return HTTP 200');
    assert.ok(Array.isArray(logsRes.json.logs), 'Logs response should contain a logs array');
    assert.ok(logsRes.json.logs.length > 0, 'Logs array should contain recent print activity logs');

    // Test clear logs API
    const clearRes = await makeRequest('POST', '/api/printers/logs/clear', { Authorization: `Bearer ${token}` });
    assert.strictEqual(clearRes.statusCode, 200, 'POST /api/printers/logs/clear should return HTTP 200');
    assert.strictEqual(clearRes.json.success, true, 'Clear logs should return success: true');

    // Test CUPS status API
    const cupsStatusRes = await makeRequest('GET', '/api/printers/cups-status', { Authorization: `Bearer ${token}` });
    assert.strictEqual(cupsStatusRes.statusCode, 200, 'GET /api/printers/cups-status should return HTTP 200');
    assert.strictEqual(cupsStatusRes.json.success, true, 'cups-status response should return success: true');
    assert.ok(Array.isArray(cupsStatusRes.json.activeJobs), 'cups-status should include activeJobs array');
    assert.ok(Array.isArray(cupsStatusRes.json.completedJobs), 'cups-status should include completedJobs array');

    // Test enable CUPS network API
    const netEnableRes = await makeRequest('POST', '/api/printers/enable-cups-network', { Authorization: `Bearer ${token}` });
    assert.strictEqual(netEnableRes.statusCode, 200, 'POST /api/printers/enable-cups-network should return HTTP 200');
    assert.strictEqual(netEnableRes.json.success, true, 'enable-cups-network should return success: true');
    assert.ok(netEnableRes.json.serverIp, 'enable-cups-network should return serverIp');

    // Cleanup test printer
    await printersModule.removeManualPrinter('net_192_168_1_250');
    console.log('  ✅ Test 6 PASSED: Printer discovery, CUPS default setting, Test printing, Print logs, CUPS status & Network IP access succeeded.\n');

    // -------------------------------------------------------------
    // Test 7: IMAP Binary Attachment Extraction Integrity & CUPS-only Mode
    // -------------------------------------------------------------
    console.log('7. Testing IMAP binary attachment extraction integrity & CUPS-only mode...');
    
    // Test binary PDF buffer base64 extraction
    const fakePdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Title (Test PDF Binary) >>\nendobj\n%%EOF\n', 'binary');
    const base64Pdf = fakePdfBytes.toString('base64');

    const fakeMime = [
      'From: test@example.com',
      'Subject: NYOMTATAS',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="--BOUNDARY12345"',
      '',
      '----BOUNDARY12345',
      'Content-Type: application/pdf; name="document.pdf"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="document.pdf"',
      '',
      base64Pdf,
      '----BOUNDARY12345--'
    ].join('\r\n');

    const extracted = printersModule.extractMimeAttachments(Buffer.from(fakeMime, 'binary'));
    assert.strictEqual(extracted.length, 1, 'Should extract 1 attachment');
    assert.strictEqual(extracted[0].filename, 'document.pdf', 'Filename should match document.pdf');
    assert.deepStrictEqual(extracted[0].data, fakePdfBytes, 'Extracted binary Buffer must match original PDF bytes byte-for-byte');

    // Test nested boundary MIME extraction & RFC 2231 filename decoding
    const nestedMime = [
      'From: test@example.com',
      'Subject: NYOMTATAS',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="OUTER_BOUND"',
      '',
      '--OUTER_BOUND',
      'Content-Type: multipart/related; boundary="INNER_BOUND"',
      '',
      '--INNER_BOUND',
      'Content-Type: application/pdf',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment;',
      '\tfilename*=UTF-8\'\'teszt%20dokumentum.pdf',
      '',
      base64Pdf,
      '--INNER_BOUND--',
      '--OUTER_BOUND--'
    ].join('\r\n');

    const nestedExtracted = printersModule.extractMimeAttachments(Buffer.from(nestedMime, 'binary'));
    assert.strictEqual(nestedExtracted.length, 1, 'Should extract 1 attachment from nested MIME parts');
    assert.strictEqual(nestedExtracted[0].filename, 'teszt_dokumentum.pdf', 'RFC 2231 filename should be decoded correctly');
    assert.deepStrictEqual(nestedExtracted[0].data, fakePdfBytes, 'Nested binary Buffer payload must match original PDF bytes');

    // Test CUPS-only printer mode
    const cupsOnlyInfo = await printersModule.getPrinters();
    assert.ok(Array.isArray(cupsOnlyInfo.printers), 'getPrinters should return array');
    for (const p of cupsOnlyInfo.printers) {
      assert.strictEqual(p.type, 'cups', 'Printers listed in getPrinters must be of type cups');
    }

    // Test damaged PDF Ghostscript repair
    const damagedPdfPath = '/tmp/damaged_test.pdf';
    fs.writeFileSync(damagedPdfPath, '%PDF-1.4\n1 0 obj\n<< /Title (Damaged) >>\nendobj\n', 'utf8');
    const preparedTarget = await printersModule.prepareFileForCupsPrinting(damagedPdfPath);
    assert.ok(fs.existsSync(preparedTarget), 'Prepared target file must exist');
    if (fs.existsSync(damagedPdfPath)) fs.unlinkSync(damagedPdfPath);
    if (preparedTarget !== damagedPdfPath && fs.existsSync(preparedTarget)) fs.unlinkSync(preparedTarget);

    console.log('  ✅ Test 7 PASSED: IMAP binary attachment extraction, damaged PDF repair & CUPS-only printer mode verified.\n');

    // -------------------------------------------------------------
    // Test 8: Apple Time Machine Backup Server & Avahi Bonjour Zero-Conf
    // -------------------------------------------------------------
    console.log('8. Testing Apple Time Machine Backup Server & Avahi Bonjour Zero-Conf...');
    const timemachineModule = require('../lib/timemachine');

    // 8.1: Test Quick Setup endpoint
    const tmSetupRes = await makeRequest('POST', '/api/timemachine/quick-setup', { Authorization: `Bearer ${token}` }, {
      name: 'UnitTestTM',
      folderPath: '/tmp/test_timemachine_share',
      maxSize: '500G',
      isPublic: false,
      validUsers: 'testadmin'
    });
    assert.strictEqual(tmSetupRes.statusCode, 200, 'POST /api/timemachine/quick-setup should return 200');
    assert.strictEqual(tmSetupRes.json.success, true, 'Quick setup should succeed');
    assert.strictEqual(tmSetupRes.json.name, 'UnitTestTM', 'Share name must match');

    // Verify smb.conf fruit entries
    const smbConf = fs.readFileSync('/etc/samba/smb.conf', 'utf8');
    assert.ok(smbConf.includes('[UnitTestTM]'), 'smb.conf must contain [UnitTestTM] section');
    assert.ok(smbConf.includes('fruit:time machine = yes'), 'smb.conf must contain fruit:time machine = yes');
    assert.ok(smbConf.includes('fruit:time machine max size = 500G'), 'smb.conf must contain fruit:time machine max size = 500G');
    assert.ok(smbConf.includes('fruit:aapl = yes'), 'smb.conf must contain fruit:aapl = yes');

    // Verify Avahi service file generation
    assert.ok(fs.existsSync('/etc/avahi/services/timemachine.service'), 'Avahi service file must exist');
    const avahiXml = fs.readFileSync('/etc/avahi/services/timemachine.service', 'utf8');
    assert.ok(avahiXml.includes('_adisk._tcp'), 'Avahi XML must advertise _adisk._tcp for Apple discovery');
    assert.ok(avahiXml.includes('adVN=UnitTestTM,adVF=0x82'), 'Avahi XML must include adVN=UnitTestTM with Time Machine flag 0x82');

    // 8.2: Test Time Machine Status endpoint
    const tmStatusRes = await makeRequest('GET', '/api/timemachine/status', { Authorization: `Bearer ${token}` });
    assert.strictEqual(tmStatusRes.statusCode, 200, 'GET /api/timemachine/status should return 200');
    assert.strictEqual(tmStatusRes.json.success, true, 'Status response success must be true');
    assert.ok(Array.isArray(tmStatusRes.json.shares), 'Status must return shares array');
    const unitTmShare = tmStatusRes.json.shares.find(s => s.name === 'UnitTestTM');
    assert.ok(unitTmShare, 'UnitTestTM must be listed in Time Machine shares');
    assert.strictEqual(unitTmShare.timeMachine, true, 'Share must have timeMachine: true');
    assert.strictEqual(unitTmShare.timeMachineMaxSize, '500G', 'Share must have 500G max size');

    // 8.3: Test Mac Setup Guide endpoint
    const tmGuideRes = await makeRequest('GET', '/api/timemachine/guide?shareName=UnitTestTM', { Authorization: `Bearer ${token}` });
    assert.strictEqual(tmGuideRes.statusCode, 200, 'GET /api/timemachine/guide should return 200');
    assert.strictEqual(tmGuideRes.json.success, true, 'Guide response success must be true');
    assert.ok(tmGuideRes.json.guide.smbUrl.includes('UnitTestTM'), 'Guide SMB URL must include share name');
    assert.ok(Array.isArray(tmGuideRes.json.guide.steps), 'Guide steps must be an array');

    // 8.4: Test Sparsebundle Detection and Lock Cleanup
    const testBundleDir = '/tmp/test_timemachine_share/MacBook-Pro-Test.sparsebundle';
    const testBandsDir = path.join(testBundleDir, 'bands');
    fs.mkdirSync(testBandsDir, { recursive: true });
    fs.writeFileSync(path.join(testBandsDir, '0'), 'mock_band_data');
    fs.writeFileSync(path.join(testBundleDir, 'token'), 'active_lock_token');

    // Check status detects the mock bundle
    const tmStatusWithBundle = await makeRequest('GET', '/api/timemachine/status', { Authorization: `Bearer ${token}` });
    const detectedBundle = tmStatusWithBundle.json.backups.find(b => b.name === 'MacBook-Pro-Test.sparsebundle');
    assert.ok(detectedBundle, 'Status should detect mock MacBook-Pro-Test.sparsebundle');
    assert.strictEqual(detectedBundle.isLocked, true, 'Mock bundle with token file must be reported as locked');

    // Clean lock via API
    const unlockRes = await makeRequest('DELETE', '/api/timemachine/locks', { Authorization: `Bearer ${token}` }, {
      targetPath: testBundleDir
    });
    assert.strictEqual(unlockRes.statusCode, 200, 'DELETE /api/timemachine/locks should return 200');
    assert.strictEqual(unlockRes.json.success, true, 'Lock cleanup should succeed');
    assert.strictEqual(fs.existsSync(path.join(testBundleDir, 'token')), false, 'Token lock file must be deleted');

    // Verify bundle is now unlocked
    const tmStatusUnlocked = await makeRequest('GET', '/api/timemachine/status', { Authorization: `Bearer ${token}` });
    const unlockedBundle = tmStatusUnlocked.json.backups.find(b => b.name === 'MacBook-Pro-Test.sparsebundle');
    assert.strictEqual(unlockedBundle.isLocked, false, 'Bundle must be reported as unlocked after lock cleanup');

    // 8.5: Test Avahi Sync API
    const avahiSyncRes = await makeRequest('POST', '/api/timemachine/avahi/sync', { Authorization: `Bearer ${token}` });
    assert.strictEqual(avahiSyncRes.statusCode, 200, 'POST /api/timemachine/avahi/sync should return 200');
    assert.strictEqual(avahiSyncRes.json.success, true, 'Avahi sync should succeed');

    // Cleanup test share and directory
    await shares.deleteShare('UnitTestTM');
    if (fs.existsSync('/tmp/test_timemachine_share')) {
      fs.rmSync('/tmp/test_timemachine_share', { recursive: true, force: true });
    }

    console.log('  ✅ Test 8 PASSED: Apple Time Machine Backup Server, smb.conf fruit stack, Avahi Bonjour mDNS advertising, sparsebundle diagnostics & lock cleanup verified.\n');

    console.log('🎉 ALL SECURITY & INTEGRATION TESTS PASSED SUCCESSFULLY!');
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('❌ Test Suite Failed:', err);
  process.exit(1);
});
