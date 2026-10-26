import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

// LOCAL FIX: validate the key explicitly. Buffer.from(key, "hex") does not
// throw on bad input — it silently truncates at the first invalid character,
// so a wrong-format key (e.g. base64) became a 0-2 byte cipher key instead of
// an error. Format is now canonical everywhere: EXACTLY 64 hex chars (32
// bytes), the same format approvalProvenance.ts and (since the local port)
// okxExchange.ts decode.
function keyBytes(keyHex) {
  if (typeof keyHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      "EXCHANGE_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes) — " +
      "generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(keyHex, "hex");
}

export function encryptApiKey(plaintext, keyHex) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBytes(keyHex), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptApiKey(ciphertext, keyHex) {
  const data = Buffer.from(ciphertext, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = data.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, keyBytes(keyHex), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function fingerprintApiKey(key) {
  if (key.length <= 8) return key;
  return key.slice(0, 4) + "..." + key.slice(-4);
}