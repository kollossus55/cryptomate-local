import assert from 'node:assert';
import { toBase32, fromBase32, generateCode, verifyCode, generateSecret, buildOtpAuthUri, generateBackupCodes } from '../server/totp.js';

let p=0,f=0;
const t=(n,fn)=>{try{fn();p++;console.log('  PASS  '+n)}catch(e){f++;console.log('  FAIL  '+n+'\n        '+e.message)}};

// RFC 4648 base32 vectors
t('base32 round-trips', () => {
  const buf = Buffer.from('12345678901234567890');
  assert.strictEqual(fromBase32(toBase32(buf)).toString(), buf.toString());
});

// RFC 6238 Appendix B test vectors (SHA-1, secret "12345678901234567890")
t('RFC 6238 test vectors (SHA-1, 8-digit truncated to 6)', () => {
  const secret = toBase32(Buffer.from('12345678901234567890'));
  // time, expected 8-digit code from the RFC; we compare the last 6 digits
  const vectors = [
    [59,          '94287082'],
    [1111111109,  '07081804'],
    [1111111111,  '14050471'],
    [1234567890,  '89005924'],
    [2000000000,  '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, rfc8] of vectors) {
    const expected = rfc8.slice(-6);
    const actual = generateCode(secret, seconds * 1000);
    assert.strictEqual(actual, expected, `t=${seconds}: got ${actual}, expected ${expected}`);
  }
});

t('a freshly generated code verifies', () => {
  const s = generateSecret();
  const code = generateCode(s);
  assert.strictEqual(verifyCode(s, code).ok, true);
});

t('a wrong code is rejected', () => {
  const s = generateSecret();
  assert.strictEqual(verifyCode(s, '000000').ok === true && generateCode(s) !== '000000', false);
});

t('accepts one step of clock drift either side', () => {
  const s = generateSecret();
  const now = Date.now();
  assert.strictEqual(verifyCode(s, generateCode(s, now - 30000), { at: now }).ok, true, 'previous step');
  assert.strictEqual(verifyCode(s, generateCode(s, now + 30000), { at: now }).ok, true, 'next step');
});

t('rejects two steps of drift', () => {
  const s = generateSecret();
  const now = Date.now();
  assert.strictEqual(verifyCode(s, generateCode(s, now - 90000), { at: now }).ok, false);
});

t('REPLAY: a used code cannot be used again', () => {
  const s = generateSecret();
  const now = Date.now();
  const first = verifyCode(s, generateCode(s, now), { at: now });
  assert.ok(first.ok);
  const replay = verifyCode(s, generateCode(s, now), { at: now, lastUsedStep: first.step });
  assert.strictEqual(replay.ok, false);
  assert.strictEqual(replay.reason, 'replayed');
});

t('malformed input rejected without throwing', () => {
  const s = generateSecret();
  for (const bad of [null, undefined, '', '12', 'abcdef', '1234567']) {
    assert.strictEqual(verifyCode(s, bad).ok, false);
  }
});

t('secrets are 32 base32 chars (20 bytes) and unique', () => {
  const a = generateSecret(), b = generateSecret();
  assert.strictEqual(a.length, 32);
  assert.notStrictEqual(a, b);
});

t('otpauth URI is well formed', () => {
  const uri = buildOtpAuthUri({ secret: 'ABC234', account: 'kollossus55@gmail.com' });
  assert.ok(uri.startsWith('otpauth://totp/'));
  assert.ok(uri.includes('secret=ABC234'));
  assert.ok(uri.includes('issuer=CryptoMate'));
  assert.ok(uri.includes('period=30'));
});

t('backup codes are unique and formatted', () => {
  const codes = generateBackupCodes(10);
  assert.strictEqual(codes.length, 10);
  assert.strictEqual(new Set(codes).size, 10);
  assert.ok(codes.every(c => /^[0-9A-F]{5}-[0-9A-F]{5}$/.test(c)));
});

console.log(`\n  ${p} passed, ${f} failed\n`);
process.exit(f?1:0);
