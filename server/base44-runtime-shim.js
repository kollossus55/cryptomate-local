/**
 * Stands in for Deno's `base44:runtime` module.
 *
 * Only `secrets.get` is used, to read EXCHANGE_ENCRYPTION_KEY. Base44 kept that
 * in a platform secret store; locally it comes from the environment, which is
 * why .env is gitignored and never written to the data directory.
 *
 * `get` must be SYNCHRONOUS, like Deno.env.get. Every call site does an
 * unawaited `if (!key)`, then passes the value straight into Buffer/crypto
 * calls — an async get returned a Promise there, which is always truthy and
 * never crypto material. That broke manual trade approvals (always 500), the
 * manual-approval signing step in the trading worker, and saving/testing a
 * custom LLM key.
 */

export const secrets = {
  get: (key) => process.env[key] ?? null,
  // Present so a future caller does not fail on an undefined method; writing
  // secrets to disk from application code is deliberately not supported.
  set: async () => {
    throw new Error('Setting secrets at runtime is not supported locally — put it in .env');
  },
};

// LOCAL FIX: outward fetches in the functions (order placement, credential
// validation, LLM calls) had NO timeout. A hung exchange connection stalled
// the trading cycle past its lease — during which exits, including live
// stop-loss-equivalents, do not fire. Node's floor is ~300s (undici headers
// timeout), far beyond "respond now or we abort the order". This needs a
// central fix rather than per-function edits: these files are kept
// copy-compatible with Base44, and a wrapper here covers any present and
// future call site. Callers that pass their own signal (market data uses its
// own 8s) keep full control; this only imposes a ceiling on the bare calls.
//
// 20s: long enough for slow LLM responses on paper-only functions, short
// enough that a wedged connection cannot eat a trading cycle.
if (!globalThis.__CRYPTOMATE_FETCH_TIMEOUT_GUARD__) {
  globalThis.__CRYPTOMATE_FETCH_TIMEOUT_GUARD__ = true;
  const ORIGINAL_FETCH = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    if (init.signal) return ORIGINAL_FETCH(input, init);
    return ORIGINAL_FETCH(input, { ...init, signal: AbortSignal.timeout(20_000) });
  };
}

export default { secrets };
