/**
 * Password lock.
 *
 * Real access control, not a cosmetic screen: the server refuses API requests
 * without a valid session, so the data cannot be read by reloading the page,
 * calling the API directly, or opening it from another browser.
 *
 * What it does NOT protect against: anyone with access to the machine itself.
 * The data sits in plain JSON under data/, and the password only gates the HTTP
 * API. That is the honest boundary — this stops someone at your keyboard or on
 * your network, not someone with your disk.
 *
 * TRADING CONTINUES WHILE LOGGED OUT. The scheduler and backend functions run
 * in the server process and never consult a session. That is deliberate: a bot
 * that stopped honouring stop-losses because you locked the screen would be far
 * more dangerous than the screen being visible.
 */

import { randomBytes, scryptSync, timingSafeEqual, randomUUID, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  generateSecret, verifyCode, buildOtpAuthUri,
  generateBackupCodes, normalizeBackupCode,
} from './totp.js';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // a week
const SESSION_COOKIE = 'cryptomate_session';

// scrypt parameters. N=2^15 costs roughly 100ms per attempt, slow enough to
// make guessing impractical and fast enough not to be noticed.
//
// maxmem must be set explicitly: these parameters need 128 * N * r = 32MB,
// which is exactly Node's default cap, so without raising it every call fails
// with "memory limit exceeded".
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

export class Auth {
  constructor(dataDir, log) {
    this.file = path.join(dataDir, 'auth.json');
    this.log = log;
    this.sessions = new Map();   // token -> expiry. In memory: a restart logs you out.
    this.failures = [];          // timestamps, for rate limiting
    this.pendingMfa = new Map(); // challenge -> expiry, between password and code
    this.pendingEnrolment = new Map(); // token -> secret, before 2FA is confirmed
  }

  _read() {
    if (!existsSync(this.file)) return null;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  _write(record) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /** True once a password has been set. */
  get isConfigured() {
    const record = this._read();
    return Boolean(record?.hash && record?.salt);
  }

  setPassword(password) {
    if (typeof password !== 'string' || password.length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const salt = randomBytes(32);
    const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
    this._write({
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      params: SCRYPT,
      updated_at: new Date().toISOString(),
    });
    // Changing the password ends every existing session.
    this.sessions.clear();
    this.log?.info('Password set — all sessions cleared');
  }

  /**
   * Rate limit: 10 failures in 15 minutes locks attempts for 15 minutes.
   * Without this, a local attacker can try passwords as fast as the CPU allows.
   */
  _rateLimited() {
    const cutoff = Date.now() - 15 * 60_000;
    this.failures = this.failures.filter((t) => t > cutoff);
    return this.failures.length >= 10;
  }

  verify(password) {
    if (this._rateLimited()) {
      return { ok: false, error: 'Too many failed attempts. Wait 15 minutes.' };
    }

    const record = this._read();
    if (!record) return { ok: false, error: 'No password is set' };

    const salt = Buffer.from(record.salt, 'hex');
    const expected = Buffer.from(record.hash, 'hex');
    // Older records may predate the explicit maxmem, so fill it in rather than
    // failing to verify a password that was set correctly.
    const params = { ...SCRYPT, ...(record.params || {}), maxmem: SCRYPT.maxmem };

    let actual;
    try {
      actual = scryptSync(password ?? '', salt, params.keylen, params);
    } catch {
      return { ok: false, error: 'Incorrect password' };
    }

    // timingSafeEqual, not ===, so response time does not leak how much of the
    // hash matched.
    const match = actual.length === expected.length && timingSafeEqual(actual, expected);
    if (!match) {
      this.failures.push(Date.now());
      return { ok: false, error: 'Incorrect password' };
    }

    this.failures = [];
    return { ok: true };
  }

  createSession() {
    const token = randomUUID() + randomBytes(24).toString('hex');
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  isValidSession(token) {
    if (!token) return false;
    const expiry = this.sessions.get(token);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  destroySession(token) {
    if (token) this.sessions.delete(token);
  }

  /** Read the session token from a Cookie header. */
  static tokenFromRequest(req) {
    const header = req.headers?.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) return rest.join('=');
    }
    return null;
  }

  static cookieHeader(token, { clear = false } = {}) {
    // HttpOnly so page scripts cannot read it; SameSite=Strict so another site
    // cannot drive the API in your session. Not Secure, because this is served
    // over plain HTTP on loopback where TLS would mean a self-signed warning.
    const base = `${SESSION_COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict`;
    return clear ? `${base}; Max-Age=0` : `${base}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  }
}

export { SESSION_COOKIE };

// ---------------------------------------------------------------------------
// Two-factor authentication (TOTP)
// ---------------------------------------------------------------------------

const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Secret-at-rest protection (LOCAL FIX).
//
// The TOTP secret used to sit in plaintext in auth.json. The stated boundary
// is "anyone with the disk is game over", but auth.json is also the ONE file
// that unlocks every future login forever — and the app already encrypts
// exchange and LLM keys at rest, so a second factor sitting next to them in
// the clear was inconsistent and, on a stolen-auth.json scenario, outright
// pointless.
//
// Encrypted with AES-256-GCM under EXCHANGE_ENCRYPTION_KEY (64 hex chars in
// .env), the same key and format validated by base44/shared/aiModelCrypto.ts.
// Kept local rather than imported so Auth never depends on Node's TS-loading
// path — the format (iv|tag|ciphertext, base64) is identical to that file.
//
// Consequences, deliberately:
//   * 2FA cannot be ENABLED without the key. Same policy as storing exchange
//     credentials — fail closed rather than half-protect.
//   * Rotating or losing the key makes the stored secret undecryptable;
//     recovery is re-enrolling 2FA under Security (the documented full reset
//     by deleting auth.json is unchanged). Not recoverable by design.
// ---------------------------------------------------------------------------

function requireEncryptionKey() {
  const keyHex = process.env.EXCHANGE_ENCRYPTION_KEY;
  if (typeof keyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      'EXCHANGE_ENCRYPTION_KEY must be set to exactly 64 hex characters (32 bytes) in .env ' +
      "before two-factor authentication can be enabled — it is what encrypts the TOTP secret at rest. " +
      "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(keyHex, 'hex');
}

function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', requireEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encoding: 'aes-256-gcm',
    payload: Buffer.concat([iv, authTag, encrypted]).toString('base64'),
  };
}

function decryptSecret({ encoding, payload }) {
  if (encoding !== 'aes-256-gcm') throw new Error(`Unknown secret encoding: ${encoding}`);

  const data = Buffer.from(payload, 'base64');
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  try {
    const decipher = createDecipheriv('aes-256-gcm', requireEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    // Key rotated, corrupted, or the record was tampered with. Never pretend
    // the entered code might simply be wrong — the stored secret itself is
    // unreadable, and re-enrolling 2FA is the real fix.
    throw new Error('The stored 2FA secret could not be decrypted (encryption key changed or corrupted?). Re-enrol two-factor under Security.');
  }
}

/** Backup codes are stored hashed, so auth.json never holds a usable code. */

// LOCAL FIX: backup codes were hashed with bare SHA-256 — no salt, no KDF —
// so a copied auth.json could be brute-forced to plaintext in seconds on a
// GPU. The codes are random and short-lived-ish; their only defense at rest
// is the hash, so make it expensive: per-code random salt + scrypt. Salted scrypt
// prevents precomputed tables, and the KDF forces every guess through ~80ms
// of work — the whole point is that brute-forcing a copy of auth.json is no
// longer a GPU-minute. Online guessing is already covered by lockout + single
// challenge per password entry.
//
// N=2^14 emits ~80ms per code: ten codes hash at enrolment, and a backup-code
// sign-in hashes up to ten — worst case under a second, only on the rarely
// used code path. Deliberately lighter than the password scrypt (N=2^15).
const BACKUP_CODE_SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 };

function hashBackupCodeSalted(code) {
  const salt = randomBytes(16);
  const hash = scryptSync(normalizeBackupCode(code), salt, BACKUP_CODE_SCRYPT.keylen, BACKUP_CODE_SCRYPT);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

/**
 * Verify a submitted backup code against a stored record.
 *
 * Storage shapes:
 *   string            legacy bare SHA-256 hex (pre-2026-10-26) — compare as-is
 *   { salt, hash }    salted scrypt over the normalized code (current format)
 *   { salt, hash,
 *     kdf: 'sha256-digest' }  salted scrypt over the legacy digest — used by
 *                     the one-shot migration (below) for legacy codes we no
 *                     longer hold in plaintext. Equivalent guess-work for an
 *                     attacker; a GPU brick either way.
 */
function verifyBackupCode(code, stored) {
  const normalized = normalizeBackupCode(code);

  if (typeof stored === 'string') {
    const given = createHash('sha256').update(normalized).digest();
    let expected;
    try { expected = Buffer.from(stored, 'hex'); } catch { return { matched: false }; }
    return { matched: expected.length === given.length && timingSafeEqual(given, expected), legacy: true };
  }

  if (!stored || typeof stored !== 'object' || typeof stored.salt !== 'string') {
    return { matched: false };
  }

  let preImage;
  if (stored.kdf === 'sha256-digest') preImage = createHash('sha256').update(normalized).digest();
  else preImage = normalizeBackupCode(code);

  let salt, expected;
  try {
    salt = Buffer.from(stored.salt, 'hex');
    expected = Buffer.from(stored.hash, 'hex');
  } catch {
    return { matched: false };
  }

  let given;
  try {
    given = scryptSync(preImage, salt, expected.length, BACKUP_CODE_SCRYPT);
  } catch {
    return { matched: false };
  }
  return { matched: given.length === expected.length && timingSafeEqual(given, expected) };
}

/** Convert legacy entries off the weak format in one pass. */
function upgradeLegacyBackupCodes(list = []) {
  return list.map((stored) => {
    if (typeof stored !== 'string') return stored;
    const salt = randomBytes(16);
    const digest = Buffer.from(stored, 'hex');
    const hash = scryptSync(digest, salt, BACKUP_CODE_SCRYPT.keylen, BACKUP_CODE_SCRYPT);
    return { salt: salt.toString('hex'), hash: hash.toString('hex'), kdf: 'sha256-digest' };
  });
}

// defineProperties with descriptors, NOT Object.assign: assign READS each
// property, which invokes the `mfaEnabled` getter against the object literal
// (where this._read does not exist) and throws at module load.
Object.defineProperties(Auth.prototype, Object.getOwnPropertyDescriptors({
  get mfaEnabled() {
    return Boolean(this._read()?.mfa?.enabled);
  },

  /**
   * Start enrolment. The secret is held in memory only until a valid code
   * proves the authenticator actually has it — writing it to disk first would
   * leave 2FA half-enabled if the user walked away mid-setup.
   *
   * LOCAL FIX: refuses without EXCHANGE_ENCRYPTION_KEY, since that key is what
   * encrypts the secret at rest. Failing HERE (before a QR is shown) beats
   * half-enabling into an unprotectable record.
   */
  beginMfaEnrolment(account) {
    requireEncryptionKey();
    const secret = generateSecret();
    const token = randomUUID();
    this.pendingEnrolment.set(token, { secret, expires: Date.now() + MFA_CHALLENGE_TTL_MS });
    return {
      token,
      secret,
      uri: buildOtpAuthUri({ secret, account }),
    };
  },

  /** Confirm enrolment with a code from the app. Returns one-time backup codes. */
  confirmMfaEnrolment(token, code) {
    const pending = this.pendingEnrolment.get(token);
    if (!pending || Date.now() > pending.expires) {
      this.pendingEnrolment.delete(token);
      return { ok: false, error: 'Setup expired — start again.' };
    }

    const result = verifyCode(pending.secret, code);
    if (!result.ok) return { ok: false, error: 'That code is not correct. Check your phone\'s clock is accurate.' };

    const backupCodes = generateBackupCodes(10);
    const record = this._read() || {};
    record.mfa = {
      enabled: true,
      // LOCAL FIX: the secret is stored encrypted (see the header comment).
      // Only the ciphertext goes to disk; the plaintext form is never written.
      secret_enc: encryptSecret(pending.secret),
      lastUsedStep: result.step,
      // LOCAL FIX: salted scrypt records, not bare SHA-256 hex.
      backupCodes: backupCodes.map((c) => hashBackupCodeSalted(c)),
      enabled_at: new Date().toISOString(),
    };
    this._write(record);
    this.pendingEnrolment.delete(token);

    // Every other session must re-authenticate under the new requirement.
    this.sessions.clear();
    this.log?.info('Two-factor authentication enabled');

    return { ok: true, backupCodes };
  },

  disableMfa() {
    const record = this._read() || {};
    delete record.mfa;
    this._write(record);
    this.sessions.clear();
    this.log?.warn('Two-factor authentication DISABLED');
    return { ok: true };
  },

  /** Issued after a correct password when 2FA is on. */
  createMfaChallenge() {
    const challenge = randomUUID() + randomBytes(16).toString('hex');
    this.pendingMfa.set(challenge, Date.now() + MFA_CHALLENGE_TTL_MS);
    return challenge;
  },

  /**
   * Verify the second factor against a pending challenge.
   *
   * Accepts either a TOTP code or an unused backup code. The challenge is
   * consumed either way, so a failed attempt cannot be retried indefinitely
   * against the same password entry.
   */
  verifyMfa(challenge, code) {
    const expiry = this.pendingMfa.get(challenge);
    if (!expiry || Date.now() > expiry) {
      this.pendingMfa.delete(challenge);
      return { ok: false, error: 'This sign-in expired. Enter your password again.' };
    }

    if (this._rateLimited()) {
      return { ok: false, error: 'Too many failed attempts. Wait 15 minutes.' };
    }

    const record = this._read();
    const mfa = record?.mfa;
    if (!mfa?.enabled) return { ok: false, error: 'Two-factor is not enabled' };

    // TOTP first. LOCAL FIX: the secret is now stored encrypted at rest —
    // encrypted entries are decrypted here (a bad/rotated key fails with a
    // message pointing at re-enrolment, never a generic "wrong code"), and a
    // legacy plaintext entry is migrated in-place to the encrypted form. The
    // migration is persisted by the `_write` calls below whenever verification
    // gets as far as updating lastUsedStep or consuming a backup code.
    let totpSecret;
    if (mfa.secret_enc) {
      try {
        totpSecret = decryptSecret(mfa.secret_enc);
      } catch (err) {
        this.pendingMfa.delete(challenge);
        return { ok: false, error: err.message };
      }
    } else if (mfa.secret) {
      totpSecret = mfa.secret;
      delete mfa.secret;
      mfa.secret_enc = encryptSecret(mfa.secret);
    } else {
      this.pendingMfa.delete(challenge);
      return { ok: false, error: 'Two-factor record is malformed. Disable and re-enable two-factor under Security.' };
    }

    const result = verifyCode(totpSecret, code, { lastUsedStep: mfa.lastUsedStep ?? null });
    if (result.ok) {
      mfa.lastUsedStep = result.step;   // blocks replay within the same window
      this._write(record);
      this.pendingMfa.delete(challenge);
      this.failures = [];
      return { ok: true };
    }

    // Then a backup code, if it looks like one rather than a 6-digit TOTP.
    const normalized = normalizeBackupCode(code);
    if (normalized.length === 10) {
      let index = -1;
      (mfa.backupCodes || []).forEach((stored, i) => {
        if (index !== -1) return;
        const attempt = verifyBackupCode(code, stored);
        if (attempt.matched) index = i;
      });
      if (index !== -1) {
        // Single use: consumed on success. LOCAL FIX: while we are writing
        // anyway, migrate EVERY legacy bare-SHA-256 entry to its salted
        // scrypt form (via their digests — the plaintexts are gone), so no
        // weak-format code outlives the first backup-code sign-in. The code
        // being consumed is removed outright.
        mfa.backupCodes = upgradeLegacyBackupCodes(mfa.backupCodes);
        mfa.backupCodes.splice(index, 1);
        this._write(record);
        this.pendingMfa.delete(challenge);
        this.failures = [];
        this.log?.warn(`Backup code used — ${mfa.backupCodes.length} remaining`);
        return { ok: true, usedBackupCode: true, remaining: mfa.backupCodes.length };
      }
    }

    this.failures.push(Date.now());
    this.pendingMfa.delete(challenge);
    return {
      ok: false,
      error: result.reason === 'replayed'
        ? 'That code was already used. Wait for the next one.'
        : 'Incorrect code.',
    };
  },

  mfaStatus() {
    const mfa = this._read()?.mfa;
    return {
      enabled: Boolean(mfa?.enabled),
      backupCodesRemaining: mfa?.backupCodes?.length ?? 0,
      enabled_at: mfa?.enabled_at ?? null,
    };
  },
}));
