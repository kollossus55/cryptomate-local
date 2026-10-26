/**
 * TOTP — RFC 6238 time-based one-time passwords.
 *
 * Implemented directly against node:crypto rather than pulled from a package:
 * the algorithm is about forty lines, and a dependency in the authentication
 * path is a dependency that can be compromised.
 *
 * Compatible with Google Authenticator, Authy, 1Password, Bitwarden and the
 * rest — they all implement the same standard: SHA-1, 6 digits, 30-second step.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DIGITS = 6;
const STEP_SECONDS = 30;

// One step either side of now, so a code entered as the window rolls over is
// still accepted. Wider than this starts meaningfully extending the window in
// which a stolen code works.
const DRIFT_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ---------------------------------------------------------------------------
// Base32 (RFC 4648) — what authenticator apps expect
// ---------------------------------------------------------------------------

export function toBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function fromBase32(input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

/** A new 20-byte secret, base32 encoded. */
export function generateSecret() {
  return toBase32(randomBytes(20));
}

/** The code for a given counter step. */
function hotp(secretBuffer, counter) {
  const buf = Buffer.alloc(8);
  // Counter is a 64-bit big-endian integer. Written as two 32-bit halves
  // because a JS number cannot hold the full range precisely.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', secretBuffer).update(buf).digest();

  // Dynamic truncation, per the RFC.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function generateCode(secretBase32, at = Date.now()) {
  const counter = Math.floor(at / 1000 / STEP_SECONDS);
  return hotp(fromBase32(secretBase32), counter);
}

/**
 * Verify a submitted code.
 *
 * Returns the matched step so the caller can reject replays: the same code is
 * valid for 30 seconds, and without tracking the last used step an attacker who
 * observes one can reuse it within that window.
 */
export function verifyCode(secretBase32, submitted, { at = Date.now(), lastUsedStep = null } = {}) {
  const code = String(submitted ?? '').replace(/\D/g, '');
  if (code.length !== DIGITS) return { ok: false, reason: 'malformed' };

  const secret = fromBase32(secretBase32);
  const current = Math.floor(at / 1000 / STEP_SECONDS);

  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift++) {
    const step = current + drift;
    const expected = hotp(secret, step);

    const a = Buffer.from(expected);
    const b = Buffer.from(code);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      if (lastUsedStep !== null && step <= lastUsedStep) {
        return { ok: false, reason: 'replayed' };
      }
      return { ok: true, step };
    }
  }
  return { ok: false, reason: 'incorrect' };
}

/** The otpauth:// URI an authenticator app scans. */
export function buildOtpAuthUri({ secret, account, issuer = 'CryptoMate' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Backup codes
// ---------------------------------------------------------------------------

/**
 * Single-use recovery codes, for a lost or wiped phone.
 *
 * Without these, losing the authenticator means deleting auth.json and starting
 * over — which also wipes the password. Stored hashed, shown once.
 */
export function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // Grouped for legibility when written down.
    const raw = randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

export function normalizeBackupCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
