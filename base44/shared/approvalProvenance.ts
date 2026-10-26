import crypto from "node:crypto";

/**
 * Provenance for PendingTradeApproval records.
 *
 * Approvals are created by the auto-trading worker (service role) and only the
 * server holds the signing key, so a valid signature proves a record was not
 * inserted straight through the entity API.
 */

function payload(approval) {
  return [
    approval.owner_email ?? "",
    approval.asset_symbol ?? "",
    approval.signal_strength ?? "",
    approval.entry_price ?? "",
    approval.position_size_usdt ?? "",
    approval.candle_interval ?? "",
    approval.expires_at ?? "",
  ].join("|");
}

function hmac(value, keyHex) {
  // LOCAL FIX (matches aiModelCrypto.ts): validate the key BEFORE decoding.
  // Buffer.from(key, "hex") does not throw on bad input — it silently
  // truncates at the first invalid character, so a wrong-format signing key
  // (e.g. base64 of 32 bytes pasted where hex was meant) produced a 0-2 byte
  // HMAC key, brute-forceable offline. Format is canonical: exactly 64 hex
  // chars (32 bytes).
  if (typeof keyHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      "EXCHANGE_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes) — " +
      "generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return crypto.createHmac("sha256", Buffer.from(keyHex, "hex")).update(value).digest("hex");
}

export function signApproval(approval, keyHex) {
  return hmac(payload(approval), keyHex);
}

export function isWorkerApproval(approval, keyHex) {
  const token = approval?.provenance_token;
  if (typeof token !== "string" || token.length === 0) return false;
  const expected = signApproval(approval, keyHex);
  const given = Buffer.from(token, "hex");
  const want = Buffer.from(expected, "hex");
  if (given.length === 0 || given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}