/**
 * Auth and 2FA tests — exercised directly against the Auth class, no HTTP.
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Auth } from '../server/auth.js';
import { generateCode, generateSecret, normalizeBackupCode } from '../server/totp.js';
import { createHash } from 'node:crypto';

// LOCAL FIX context: enrolment now requires EXCHANGE_ENCRYPTION_KEY (it
// encrypts the TOTP secret at rest). These tests run outside the server, so
// load the project's real .env if present — else use a throwaway fixture key.
// Setting it before any Auth call keeps the suite exercising the same policy
// the live server enforces.
if (!process.env.EXCHANGE_ENCRYPTION_KEY) {
  const { existsSync, readFileSync } = await import('node:fs');
  const envPath = new URL('../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
  } else {
    process.env.EXCHANGE_ENCRYPTION_KEY = '5'.repeat(64);
  }
}

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};
const section = (n) => console.log(`\n${n}`);

const quietLog = { info: () => {}, warn: () => {}, error: () => {} };
const fresh = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-auth-'));
  return { dir, auth: new Auth(dir, quietLog) };
};
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

// Enrol 2FA and return the secret plus backup codes.
function enrol(auth) {
  const { token, secret } = auth.beginMfaEnrolment('test@example.com');
  const result = auth.confirmMfaEnrolment(token, generateCode(secret));
  assert.ok(result.ok, 'enrolment failed');
  return { secret, backupCodes: result.backupCodes };
}

// ---------------------------------------------------------------------------
section('Password');

test('starts unconfigured', () => {
  const { dir, auth } = fresh();
  assert.strictEqual(auth.isConfigured, false);
  cleanup(dir);
});

test('setting a password configures it and clears sessions', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  assert.strictEqual(auth.isConfigured, true);
  cleanup(dir);
});

test('password is never stored in plain text', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const raw = readFileSync(path.join(dir, 'auth.json'), 'utf8');
  assert.ok(!raw.includes('correct-horse-battery'), 'plaintext password found on disk');
  cleanup(dir);
});

test('rejects passwords under 8 characters', () => {
  const { dir, auth } = fresh();
  assert.throws(() => auth.setPassword('short'), /at least 8/);
  cleanup(dir);
});

test('verifies the right password and rejects the wrong one', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  assert.strictEqual(auth.verify('correct-horse-battery').ok, true);
  assert.strictEqual(auth.verify('wrong').ok, false);
  cleanup(dir);
});

test('sessions validate, then stop after destroy', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const token = auth.createSession();
  assert.strictEqual(auth.isValidSession(token), true);
  auth.destroySession(token);
  assert.strictEqual(auth.isValidSession(token), false);
  cleanup(dir);
});

test('an unknown or empty token is never valid', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  for (const bad of [null, undefined, '', 'made-up-token']) {
    assert.strictEqual(auth.isValidSession(bad), false);
  }
  cleanup(dir);
});

test('rate limit engages after 10 failures', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  for (let i = 0; i < 10; i++) auth.verify('wrong');
  const result = auth.verify('correct-horse-battery');
  assert.strictEqual(result.ok, false, 'should be locked out even with the right password');
  assert.match(result.error, /Too many/);
  cleanup(dir);
});

test('changing the password invalidates existing sessions', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const token = auth.createSession();
  auth.setPassword('a-different-password');
  assert.strictEqual(auth.isValidSession(token), false);
  cleanup(dir);
});

// ---------------------------------------------------------------------------
section('Two-factor enrolment');

test('starts disabled', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  assert.strictEqual(auth.mfaEnabled, false);
  cleanup(dir);
});

test('enrolment issues a secret and an otpauth URI', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { token, secret, uri } = auth.beginMfaEnrolment('me@example.com');
  assert.ok(token && secret);
  assert.strictEqual(secret.length, 32);
  assert.ok(uri.startsWith('otpauth://totp/'));
  // Not active until confirmed.
  assert.strictEqual(auth.mfaEnabled, false);
  cleanup(dir);
});

test('the secret is NOT written to disk until enrolment is confirmed', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { secret } = auth.beginMfaEnrolment('me@example.com');
  const raw = readFileSync(path.join(dir, 'auth.json'), 'utf8');
  assert.ok(!raw.includes(secret), 'unconfirmed secret persisted — 2FA could be left half-enabled');
  cleanup(dir);
});

test('confirming with a wrong code does not enable 2FA', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { token } = auth.beginMfaEnrolment('me@example.com');
  const result = auth.confirmMfaEnrolment(token, '000000');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(auth.mfaEnabled, false);
  cleanup(dir);
});

test('confirming with a real code enables 2FA and returns 10 backup codes', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { backupCodes } = enrol(auth);
  assert.strictEqual(auth.mfaEnabled, true);
  assert.strictEqual(backupCodes.length, 10);
  assert.strictEqual(new Set(backupCodes).size, 10);
  cleanup(dir);
});

test('backup codes are stored hashed, never in usable form', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { backupCodes } = enrol(auth);
  const raw = readFileSync(path.join(dir, 'auth.json'), 'utf8');
  for (const code of backupCodes) {
    assert.ok(!raw.includes(code), `backup code ${code} stored in plain text`);
  }
  cleanup(dir);
});

test('a stale enrolment token is refused', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const result = auth.confirmMfaEnrolment('never-issued', '123456');
  assert.strictEqual(result.ok, false);
  cleanup(dir);
});

test('the confirmed TOTP secret is NEVER in plaintext on disk (LOCAL FIX)', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { secret } = enrol(auth);
  const raw = readFileSync(path.join(dir, 'auth.json'), 'utf8');
  assert.ok(!raw.includes(secret), 'confirmed TOTP secret stored as plaintext');
  assert.ok(raw.includes('secret_enc'), 'no encrypted secret record at all');
  // And it still verifies, proving the round-trip through decryption works.
  const challenge = auth.createMfaChallenge();
  assert.strictEqual(auth.verifyMfa(challenge, generateCode(secret, Date.now() + 30_000)).ok, true);
  cleanup(dir);
});

test('2FA enrolment is refused without the at-rest encryption key (LOCAL FIX)', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const saved = process.env.EXCHANGE_ENCRYPTION_KEY;
  delete process.env.EXCHANGE_ENCRYPTION_KEY;
  try {
    assert.throws(() => auth.beginMfaEnrolment('me@example.com'), /EXCHANGE_ENCRYPTION_KEY/);
  } finally {
    process.env.EXCHANGE_ENCRYPTION_KEY = saved;
  }
  cleanup(dir);
});

test('legacy unsalted backup-code records still verify, then upgrade (LOCAL FIX)', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { backupCodes } = enrol(auth);
  // Rewind the record to the pre-2026-10-26 format: bare SHA-256 hex strings.
  const record = auth._read();
  record.mfa.backupCodes = backupCodes.map(
    (c) => createHash('sha256').update(normalizeBackupCode(c)).digest('hex')
  );
  auth._write(record);

  const result = auth.verifyMfa(auth.createMfaChallenge(), backupCodes[0]);
  assert.strictEqual(result.ok, true, 'legacy-format backup code rejected instead of migrated');

  // After the write, the used code is gone and the rest are salted records.
  const upgraded = auth._read().mfa.backupCodes;
  assert.strictEqual(upgraded.every((b) => typeof b === 'object' && b.salt), true,
    'legacy codes were not upgraded to salted scrypt records');
  cleanup(dir);
});

// ---------------------------------------------------------------------------
section('Two-factor sign-in');

test('a correct TOTP code passes the challenge', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { secret } = enrol(auth);

  // The NEXT window's code, which is what a real user enters: enrolment
  // consumed the current one, and re-using it is correctly refused as a
  // replay. A code one step ahead is inside the accepted drift window.
  const nextCode = generateCode(secret, Date.now() + 30_000);
  const challenge = auth.createMfaChallenge();
  assert.strictEqual(auth.verifyMfa(challenge, nextCode).ok, true);
  cleanup(dir);
});

test('the code used during enrolment cannot immediately sign you in', () => {
  // Enrolment consumes that step, so the same code is dead the moment it is
  // used — which is the anti-replay guarantee, verified rather than assumed.
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { secret } = enrol(auth);
  const result = auth.verifyMfa(auth.createMfaChallenge(), generateCode(secret));
  assert.strictEqual(result.ok, false);
  cleanup(dir);
});

test('a wrong code fails and consumes the challenge', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { secret } = enrol(auth);
  const challenge = auth.createMfaChallenge();
  assert.strictEqual(auth.verifyMfa(challenge, '000000').ok, false);
  // Re-using the same challenge must not work, so a single password entry
  // cannot be used to brute force codes.
  assert.strictEqual(auth.verifyMfa(challenge, generateCode(secret)).ok, false);
  cleanup(dir);
});

test('an unknown challenge is refused', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { secret } = enrol(auth);
  assert.strictEqual(auth.verifyMfa('not-a-challenge', generateCode(secret)).ok, false);
  cleanup(dir);
});

test('REPLAY: the same TOTP code cannot be used twice', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { secret } = enrol(auth);
  const code = generateCode(secret, Date.now() + 30_000);

  const first = auth.verifyMfa(auth.createMfaChallenge(), code);
  assert.strictEqual(first.ok, true);

  const second = auth.verifyMfa(auth.createMfaChallenge(), code);
  assert.strictEqual(second.ok, false, 'a code valid for 30s was accepted twice');
  cleanup(dir);
});

test('a backup code works and is consumed', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { backupCodes } = enrol(auth);

  const first = auth.verifyMfa(auth.createMfaChallenge(), backupCodes[0]);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.usedBackupCode, true);
  assert.strictEqual(auth.mfaStatus().backupCodesRemaining, 9);

  const reuse = auth.verifyMfa(auth.createMfaChallenge(), backupCodes[0]);
  assert.strictEqual(reuse.ok, false, 'a single-use backup code was accepted twice');
  cleanup(dir);
});

test('backup codes are accepted in any case and with or without the dash', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { backupCodes } = enrol(auth);
  const messy = backupCodes[0].toLowerCase().replace('-', ' ');
  assert.strictEqual(auth.verifyMfa(auth.createMfaChallenge(), messy).ok, true);
  cleanup(dir);
});

test('an invented backup code is rejected', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  enrol(auth);
  assert.strictEqual(auth.verifyMfa(auth.createMfaChallenge(), 'AAAAA-BBBBB').ok, false);
  cleanup(dir);
});

test('disabling 2FA clears it and the stored secret', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const { secret } = enrol(auth);
  auth.disableMfa();
  assert.strictEqual(auth.mfaEnabled, false);
  const raw = readFileSync(path.join(dir, 'auth.json'), 'utf8');
  assert.ok(!raw.includes(secret), 'secret left on disk after disabling');
  cleanup(dir);
});

test('enabling 2FA invalidates existing sessions', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  const token = auth.createSession();
  enrol(auth);
  assert.strictEqual(auth.isValidSession(token), false,
    'sessions created before 2FA should not survive it being enabled');
  cleanup(dir);
});

test('mfaStatus reports accurately', () => {
  const { dir, auth } = fresh();
  auth.setPassword('correct-horse-battery');
  assert.deepStrictEqual(auth.mfaStatus().enabled, false);
  enrol(auth);
  const status = auth.mfaStatus();
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.backupCodesRemaining, 10);
  assert.ok(status.enabled_at);
  cleanup(dir);
});

// ---------------------------------------------------------------------------
section('Cookies');

test('session cookie is HttpOnly and SameSite=Strict', () => {
  const header = Auth.cookieHeader('token123');
  assert.ok(header.includes('HttpOnly'), 'cookie readable by page scripts');
  assert.ok(header.includes('SameSite=Strict'), 'cookie usable cross-site');
  assert.ok(header.includes('Max-Age='));
});

test('clearing the cookie expires it immediately', () => {
  const header = Auth.cookieHeader(null, { clear: true });
  assert.ok(header.includes('Max-Age=0'));
});

test('token is parsed from a Cookie header, ignoring others', () => {
  const req = { headers: { cookie: 'other=1; cryptomate_session=abc123; more=2' } };
  assert.strictEqual(Auth.tokenFromRequest(req), 'abc123');
  assert.strictEqual(Auth.tokenFromRequest({ headers: {} }), null);
});

console.log(`\n${'-'.repeat(52)}\n${passed} passed, ${failed} failed\n${'-'.repeat(52)}\n`);
process.exit(failed > 0 ? 1 : 0);
