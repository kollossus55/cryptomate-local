/**
 * Local replacement for the Base44 SDK client.
 *
 * This file exposes EXACTLY the same surface the app already calls:
 *
 *   base44.entities.<Name>.list / filter / create / update / delete /
 *                              deleteMany / updateMany / get / bulkCreate
 *   base44.functions.invoke(name, payload)
 *   base44.auth.me / isAuthenticated / logout / redirectToLogin
 *
 * Because the shape is identical, every page and component in src/ works
 * unchanged — no imports rewritten, no call sites edited. The only thing that
 * changes is where the data comes from: a local Node server on this machine
 * instead of Base44's cloud.
 *
 * Differences worth knowing:
 *  - There is one user. This runs on your machine, for you, so auth is a stub
 *    that always returns the local operator rather than a login flow.
 *  - Entity methods return plain arrays/objects, same as the SDK.
 *  - functions.invoke returns { data } to match the SDK's response shape, which
 *    is what the existing call sites destructure.
 */

// In production the UI is served BY the local server, so same-origin relative
// URLs work and there is no CORS. In `vite dev` the UI is on :5173 and the
// server on :8788, so it needs the absolute address.
const API = import.meta.env?.VITE_API_URL
  ?? (import.meta.env?.DEV ? 'http://127.0.0.1:8788' : '');

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      // The session lives in an HttpOnly cookie, so it only travels if
      // credentials are included — in dev the UI is on a different port.
      credentials: 'include',
      ...options,
    });
  } catch (err) {
    // The most common failure by far: the server is not running. Say so
    // plainly rather than surfacing a bare "Failed to fetch" in the UI.
    throw new ApiError(
      `Cannot reach the local server${API ? ` at ${API}` : ''}. Is it running? Start it with: npm start`,
      0,
      null
    );
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  if (!res.ok) {
    const message = (body && body.error) || `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body);
  }
  return body;
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    search.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

/**
 * One entity collection. Mirrors the SDK's method names and argument order.
 */
function entity(name) {
  return {
    // list(sort, limit) — sort is a field name, '-field' for descending.
    list: (sort, limit) => request(`/api/entities/${name}${qs({ sort, limit })}`),

    // filter(query, sort, limit)
    filter: (query, sort, limit) =>
      request(`/api/entities/${name}${qs({ filter: query, sort, limit })}`),

    get: (id) => request(`/api/entities/${name}/${encodeURIComponent(id)}`),

    create: (data) =>
      request(`/api/entities/${name}`, { method: 'POST', body: JSON.stringify(data) }),

    bulkCreate: (rows) =>
      request(`/api/entities/${name}/bulk`, { method: 'POST', body: JSON.stringify(rows) }),

    update: (id, data) =>
      request(`/api/entities/${name}/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),

    updateMany: (query, data) =>
      request(`/api/entities/${name}/many`, {
        method: 'PATCH', body: JSON.stringify({ query, data }),
      }),

    delete: (id) =>
      request(`/api/entities/${name}/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    deleteMany: (query) =>
      request(`/api/entities/${name}/many`, {
        method: 'DELETE', body: JSON.stringify({ query }),
      }),
  };
}

// The entity names the app uses. Kept explicit rather than proxied so a typo
// in a page fails loudly at the call site instead of silently creating a new
// empty collection on the server.
const ENTITY_NAMES = [
  'AIAdvisorInsight', 'AIModelConfig', 'AISignalConfig', 'AutoTradingSettings',
  'BacktestResult', 'CalibrationModel', 'ExchangeBalance', 'ExchangeConnection',
  'Notification', 'PendingTradeApproval', 'Portfolio', 'PriceAlert',
  'ScanResult', 'SignalOutcome', 'Trade', 'TradingPreferences', 'User',
];

const entities = {};
for (const name of ENTITY_NAMES) entities[name] = entity(name);

// Query was a Base44 built-in. Nothing local uses it, but src/api/entities.js
// re-exports it, so it needs to resolve to something rather than undefined.
entities.Query = entity('Query');

// Fetched from the server so there is one source of truth for the operator
// identity; falls back to a sensible default if the request has not resolved.
let LOCAL_USER = {
  id: 'local-operator',
  email: 'kollossus55@gmail.com',
  full_name: 'Administrator',
  role: 'admin',
};

export const base44 = {
  entities,

  functions: {
    /**
     * invoke(name, payload) -> { data }
     *
     * Functions run in-process on the local server. Long-running ones (the
     * trading worker, the scanner) can take a while; there is no timeout here
     * because the local server is not a shared resource being protected from
     * you.
     */
    invoke: async (name, payload = {}) => {
      const data = await request(`/api/functions/${encodeURIComponent(name)}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return { data };
    },
  },

  /**
   * Page-view analytics.
   *
   * Base44 logged which pages you visited back to the platform. Locally there
   * is nowhere to send that and no reason to — this is a no-op.
   *
   * It must still exist and still return a promise: NavigationTracker calls
   * `base44.appLogs.logUserInApp(page).catch(...)`, and if the namespace is
   * missing the TypeError throws synchronously, before any promise exists, so
   * the .catch never runs and the whole app fails to mount on a blank page.
   */
  appLogs: {
    logUserInApp: async () => ({ ok: true }),
    log: async () => ({ ok: true }),
  },

  /**
   * Local maintenance. No hosted equivalent — these exist only in the local
   * build, so they live outside the entities/functions surface.
   */
  maintenance: {
    resetInfo: () => request('/api/maintenance/reset-info'),
    reset: (confirm, startingBalance) =>
      request('/api/maintenance/reset', {
        method: 'POST',
        body: JSON.stringify({ confirm, startingBalance }),
      }),
  },

  auth: {
    /** Whether a password exists and whether this browser is signed in. */
    status: () => request('/api/auth/status'),

    /** First-run: create the password and sign in. */
    setup: (password) =>
      request('/api/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }),

    /**
     * Sign in. With 2FA enabled this does NOT return a session — it returns
     * { mfaRequired, challenge }, and the challenge must be exchanged for a
     * session via verifyMfa.
     */
    login: (password) =>
      request('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),

    verifyMfa: (challenge, code) =>
      request('/api/auth/mfa-verify', { method: 'POST', body: JSON.stringify({ challenge, code }) }),

    mfaStatus: () => request('/api/auth/mfa'),

    beginMfaEnrolment: () => request('/api/auth/mfa/begin', { method: 'POST' }),

    confirmMfaEnrolment: (token, code) =>
      request('/api/auth/mfa/confirm', { method: 'POST', body: JSON.stringify({ token, code }) }),

    disableMfa: (password) =>
      request('/api/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ password }) }),

    changePassword: (current, password) =>
      request('/api/auth/password', { method: 'POST', body: JSON.stringify({ current, password }) }),

    /**
     * Real signed-in state, so the landing page can tell whether to show its
     * sign-in buttons or send you straight to Trading.
     */
    isAuthenticated: async () => {
      try {
        const status = await request('/api/auth/status');
        return Boolean(status.authenticated);
      } catch {
        return false;
      }
    },

    me: async () => {
      try {
        LOCAL_USER = await request('/api/auth/me');
      } catch {
        // Server unreachable — the cached identity keeps the UI renderable.
      }
      return LOCAL_USER;
    },
    /**
     * End the session and return to the lock screen.
     *
     * The bot keeps trading while signed out — the scheduler runs in the server
     * process and never consults a session. Locking the screen must not stop
     * stop-losses from firing.
     */
    logout: async () => {
      try {
        await request('/api/auth/logout', { method: 'POST' });
      } finally {
        window.location.reload();
      }
    },

    /**
     * Open the lock screen.
     *
     * The landing page calls this from its "Sign In / Sign Up" buttons. Rather
     * than navigating anywhere — there is no hosted login to redirect to — this
     * raises an event the auth provider listens for, so Home.jsx needs no
     * changes and keeps working exactly as written.
     */
    redirectToLogin: () => {
      window.dispatchEvent(new CustomEvent('cryptomate:show-lock'));
    },
  },

  /**
   * File storage.
   *
   * Base44's Core integrations are replaced by local endpoints that write into
   * the data directory. Signatures match what the app already calls.
   */
  integrations: {
    Core: {
      UploadPublicFile: async ({ file }) => {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`${API}/api/files/upload`, { method: 'POST', body: form });
        if (!res.ok) throw new ApiError('Upload failed', res.status, null);
        return res.json();
      },
      UploadPrivateFile: async ({ file }) => {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`${API}/api/files/upload`, { method: 'POST', body: form });
        if (!res.ok) throw new ApiError('Upload failed', res.status, null);
        return res.json();
      },
      // Everything is local, so a "signed" URL is just the file's own URL.
      CreateFileSignedUrl: async ({ file_uri }) => ({ signed_url: file_uri }),
    },
  },

  // Some call sites reach for this when reporting errors.
  appId: 'cryptomate-local',
};

export default base44;
export { ApiError, API as API_BASE_URL };
