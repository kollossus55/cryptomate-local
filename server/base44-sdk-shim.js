/**
 * Stands in for `npm:@base44/sdk` inside the backend functions.
 *
 * The loader hook resolves any @base44/sdk import to this file, so the
 * functions' own `import { createClientFromRequest } from 'npm:@base44/sdk@…'`
 * lines work untouched.
 *
 * The client itself is installed on globalThis by the server at startup —
 * module scope cannot reach the server instance any other way, and there is
 * exactly one server per process.
 */

export function createClientFromRequest(_req) {
  const client = globalThis.__CRYPTOMATE_BASE44__;
  if (!client) {
    throw new Error(
      'Local Base44 shim is not installed. The server must call installBase44Client() before loading functions.'
    );
  }
  return client;
}

export function createClient(_options) {
  return createClientFromRequest(null);
}

export default { createClientFromRequest, createClient };
