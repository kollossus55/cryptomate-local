#!/usr/bin/env node
/**
 * CryptoMate local server.
 *
 * Replaces Base44's backend: entity storage, function execution and the
 * scheduled workflows, all on this machine. The React app talks to it through
 * src/api/base44Client.js, which exposes the same surface the SDK did.
 *
 * Bound to 127.0.0.1. This serves your positions and can arm live trading, so
 * it must not be reachable from the network.
 */

import { createServer } from 'node:http';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

// Loader hooks must be registered BEFORE any function module is imported,
// otherwise their npm:@base44/sdk imports fail to resolve.
register('./loaderHooks.js', pathToFileURL(path.join(ROOT, 'server/')).href);

// .env FIRST: entityStore reads OPERATOR_EMAIL at module scope, so loading it
// afterwards would mean the override silently never applies.
const { loadEnv } = await import('./env.js');
loadEnv(ROOT);

const {
  EntityStore, LOCAL_USER_EMAIL, migrateOperatorEmail, ensureOperatorUser,
  snapshotEntities, resetTradingData, RESET_CLEARS, RESET_KEEPS,
} = await import('./entityStore.js');
const { FunctionRegistry, makeBase44Shim } = await import('./functionRuntime.js');
const { Logger } = await import('./logger.js');
const { Scheduler } = await import('./scheduler.js');
const { Auth } = await import('./auth.js');

/**
 * Build marker, logged unconditionally at startup.
 *
 * Exists because a stale copy of this folder is indistinguishable from a
 * current one in the logs: the same failure can come from old code or from new
 * code failing deeper, and chasing the wrong one wastes an afternoon. If the
 * line below does not match the build you just installed, the files did not
 * replace — usually because the server was still running and Windows refused
 * to overwrite them.
 */
const BUILD = '2026-10-26.1 — sync secrets shim, CORS allowlist, crash handlers exit';

const PORT = Number(process.env.PORT || 8788);
const HOST = process.env.HOST || '127.0.0.1';

const log = new Logger({ dir: path.join(DATA, 'logs') });
const store = new EntityStore(DATA);

// Re-stamp any records created under an older operator email, so changing it
// does not hide existing data from the functions that filter on created_by.
migrateOperatorEmail(store, { log });

// The admin page lists the User entity, which nothing else populates locally.
ensureOperatorUser(store, { log });

const auth = new Auth(DATA, log);

// The functions reach this through the SDK shim.
// getRegistry is lazy: the shim is built before any function is loaded, but
// functions need to invoke each other at run time.
globalThis.__CRYPTOMATE_BASE44__ = makeBase44Shim(store, { getRegistry: () => registry });

const registry = new FunctionRegistry({
  functionsDir: path.join(ROOT, 'base44', 'functions'),
  store,
  log,
});

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const json = (res, status, body, extraHeaders = {}) => {
  const payload = JSON.stringify(body ?? null);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  };
  // CORS: the built UI is served from this same origin, so it needs no CORS
  // header at all. Only the Vite dev server (loopback :5173) is cross-origin.
  // A bare '*' would let any webpage the user browses reach the pre-auth
  // routes directly — reading /api/health, and hammering /api/auth/login to
  // keep the owner locked out via the shared failure list.
  const origin = reqOrigin.get(res);
  if (origin && DEV_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET,POST,PATCH,DELETE,OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, { ...headers, ...extraHeaders });
  res.end(payload);
};

const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
// Stash the request's Origin per response object, because json() only receives
// the response.
const reqOrigin = new WeakMap();

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 25 * 1024 * 1024) { reject(new Error('Request body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return resolve({});
    try { resolve(JSON.parse(text)); } catch { reject(new Error('Invalid JSON body')); }
  });
  req.on('error', reject);
});

const parseQuery = (url) => {
  const out = {};
  for (const [k, v] of url.searchParams) {
    if (k === 'filter') {
      try { out.filter = JSON.parse(v); } catch { out.filter = undefined; }
    } else out[k] = v;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const segments = url.pathname.split('/').filter(Boolean);

  // Remember the request Origin so json() can decide on CORS per response.
  if (req.headers.origin) reqOrigin.set(res, req.headers.origin);

  if (req.method === 'OPTIONS') return json(res, 204, null);

  // GET /api/health — SERVER LIVENESS ONLY when unauthenticated (LOCAL FIX).
  //
  // A hostile page in the user's browser could previously read function names,
  // failed-function load errors, and scheduler state from here. The CORS
  // fix removed the cross-origin path to it, but a loopback process (malware
  // or a broken local app) can still curl it on 127.0.0.1, so the disclose
  // nothing but "alive" until a password is set — or a session exists.
  if (segments[0] === 'api' && segments[1] === 'health') {
    const canSee = !auth.isConfigured || auth.isValidSession(Auth.tokenFromRequest(req));
    if (!canSee) {
      return json(res, 200, { ok: true });
    }
    return json(res, 200, {
      ok: true,
      build: BUILD,
      sdkShim: Object.keys(globalThis.__CRYPTOMATE_BASE44__ || {}),
      functions: registry.handlers.size,
      failed: [...registry.loadErrors.keys()],
      scheduler: scheduler?.status() ?? null,
    });
  }

  // ── Auth ────────────────────────────────────────────────────────────────
  if (segments[0] === 'api' && segments[1] === 'auth') {
    const action = segments[2];

    // Unauthenticated: lets the UI decide between setup, login and app.
    if (action === 'status') {
      return json(res, 200, {
        configured: auth.isConfigured,
        authenticated: auth.isValidSession(Auth.tokenFromRequest(req)),
        mfaEnabled: auth.mfaEnabled,
      });
    }

    // First-run password creation. Only possible while none is set, so this
    // cannot be used to overwrite an existing password without logging in.
    if (action === 'setup' && req.method === 'POST') {
      if (auth.isConfigured) return json(res, 400, { error: 'A password is already set' });
      try {
        const { password } = await readBody(req);
        auth.setPassword(password);
        const token = auth.createSession();
        return json(res, 200, { ok: true }, { 'Set-Cookie': Auth.cookieHeader(token) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (action === 'login' && req.method === 'POST') {
      const { password } = await readBody(req);
      const result = auth.verify(password);
      if (!result.ok) {
        log.warn('Failed login attempt');
        return json(res, 401, { error: result.error });
      }

      // With 2FA on, a correct password is not a session — it only earns the
      // right to present the second factor.
      if (auth.mfaEnabled) {
        return json(res, 200, { mfaRequired: true, challenge: auth.createMfaChallenge() });
      }

      const token = auth.createSession();
      log.info('Signed in');
      return json(res, 200, { ok: true }, { 'Set-Cookie': Auth.cookieHeader(token) });
    }

    if (action === 'mfa-verify' && req.method === 'POST') {
      const { challenge, code } = await readBody(req);
      const result = auth.verifyMfa(challenge, code);
      if (!result.ok) {
        log.warn('Failed two-factor attempt');
        return json(res, 401, { error: result.error });
      }
      const token = auth.createSession();
      log.info(`Signed in${result.usedBackupCode ? ' using a backup code' : ''}`);
      return json(res, 200, {
        ok: true,
        usedBackupCode: result.usedBackupCode ?? false,
        backupCodesRemaining: result.remaining,
      }, { 'Set-Cookie': Auth.cookieHeader(token) });
    }

    // ── 2FA management (session required) ─────────────────────────────────
    if (action === 'mfa') {
      const signedIn = auth.isValidSession(Auth.tokenFromRequest(req));
      if (!signedIn) return json(res, 401, { error: 'Not signed in' });

      const sub = segments[3];

      if (req.method === 'GET' || !sub) {
        return json(res, 200, auth.mfaStatus());
      }

      if (sub === 'begin' && req.method === 'POST') {
        if (auth.mfaEnabled) return json(res, 400, { error: 'Two-factor is already enabled' });
        // Enrolment throws when EXCHANGE_ENCRYPTION_KEY is absent/unusable.
        // Surfacing THAT message here beats a generic 500 'Internal error'.
        let enrolment;
        try {
          enrolment = auth.beginMfaEnrolment(LOCAL_USER_EMAIL);
        } catch (err) {
          return json(res, 500, { error: err.message });
        }
        let qr = null;
        try {
          const QRCode = (await import('qrcode')).default;
          qr = await QRCode.toDataURL(enrolment.uri, { margin: 1, width: 240 });
        } catch (err) {
          // The QR is a convenience; the secret can always be typed in by hand.
          log.warn(`QR generation failed: ${err.message}`);
        }
        return json(res, 200, { token: enrolment.token, secret: enrolment.secret, uri: enrolment.uri, qr });
      }

      if (sub === 'confirm' && req.method === 'POST') {
        const { token, code } = await readBody(req);
        const result = auth.confirmMfaEnrolment(token, code);
        if (!result.ok) return json(res, 400, { error: result.error });
        // Enrolment clears sessions, so issue a fresh one rather than logging
        // the user out of the setup they just completed.
        const fresh = auth.createSession();
        return json(res, 200, { ok: true, backupCodes: result.backupCodes },
          { 'Set-Cookie': Auth.cookieHeader(fresh) });
      }

      if (sub === 'disable' && req.method === 'POST') {
        // Password required: a walk-up attacker with an unlocked screen should
        // not be able to remove the second factor.
        const { password } = await readBody(req);
        const check = auth.verify(password);
        if (!check.ok) return json(res, 401, { error: 'Password is incorrect' });
        auth.disableMfa();
        const fresh = auth.createSession();
        return json(res, 200, { ok: true }, { 'Set-Cookie': Auth.cookieHeader(fresh) });
      }

      return json(res, 404, { error: 'Unknown 2FA action' });
    }

    if (action === 'logout' && req.method === 'POST') {
      auth.destroySession(Auth.tokenFromRequest(req));
      log.info('Signed out — trading continues in the background');
      return json(res, 200, { ok: true }, { 'Set-Cookie': Auth.cookieHeader(null, { clear: true }) });
    }

    if (action === 'password' && req.method === 'POST') {
      // Changing the password requires an active session.
      if (!auth.isValidSession(Auth.tokenFromRequest(req))) {
        return json(res, 401, { error: 'Not signed in' });
      }
      try {
        const { current, password } = await readBody(req);
        const check = auth.verify(current);
        if (!check.ok) return json(res, 401, { error: 'Current password is incorrect' });
        auth.setPassword(password);
        const token = auth.createSession();
        return json(res, 200, { ok: true }, { 'Set-Cookie': Auth.cookieHeader(token) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (action === 'me') {
      if (auth.isConfigured && !auth.isValidSession(Auth.tokenFromRequest(req))) {
        return json(res, 401, { error: 'Not signed in' });
      }
      return json(res, 200, {
        id: 'local-operator', email: LOCAL_USER_EMAIL,
        full_name: process.env.OPERATOR_NAME || 'Administrator', role: 'admin',
      });
    }

    return json(res, 404, { error: 'Unknown auth action' });
  }

  // ── Gate every other API route ──────────────────────────────────────────
  // Only reached once a password exists, so a fresh install is usable before
  // setup. Static files are not gated: the UI has to load in order to show the
  // login form, and it contains no data of its own.
  if (segments[0] === 'api' && auth.isConfigured &&
      !auth.isValidSession(Auth.tokenFromRequest(req))) {
    return json(res, 401, { error: 'Not signed in' });
  }

  // /api/functions/:name
  if (segments[0] === 'api' && segments[1] === 'functions') {
    const name = segments[2];
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
    try {
      const payload = await readBody(req);
      log.info(`invoke ${name}`);
      const result = await registry.invoke(name, payload);
      return json(res, 200, result);
    } catch (err) {
      log.error(`function ${name} failed: ${err.message}`);
      return json(res, err.status || 500, { error: err.message });
    }
  }

  // /api/entities/:name[/:id | /many | /bulk]
  if (segments[0] === 'api' && segments[1] === 'entities') {
    const name = segments[2];
    const tail = segments[3];
    if (!name) return json(res, 400, { error: 'Entity name required' });

    // The operator's own User record is what makes the admin page reachable
    // (it checks role === 'admin'). Deleting or demoting it would lock you out
    // of that page until the next server restart repaired it, so refuse here
    // rather than letting the UI offer a button that breaks things.
    if (name === 'User' && tail && tail !== 'many' && tail !== 'bulk' &&
        (req.method === 'DELETE' || req.method === 'PATCH')) {
      const target = store.get('User', tail);
      if (target?.email === LOCAL_USER_EMAIL) {
        if (req.method === 'DELETE') {
          return json(res, 400, { error: 'You cannot delete your own operator account.' });
        }
        const patch = await readBody(req);
        if (patch.role && patch.role !== 'admin') {
          return json(res, 400, { error: 'You cannot remove admin from your own account.' });
        }
        const updated = store.update('User', tail, patch);
        return json(res, 200, updated);
      }
    }

    try {
      if (req.method === 'GET' && !tail) {
        return json(res, 200, store.list(name, parseQuery(url)));
      }
      if (req.method === 'GET' && tail) {
        const row = store.get(name, tail);
        return row ? json(res, 200, row) : json(res, 404, { error: 'Not found' });
      }
      if (req.method === 'POST' && tail === 'bulk') {
        return json(res, 200, store.bulkCreate(name, await readBody(req)));
      }
      if (req.method === 'POST') {
        return json(res, 200, store.create(name, await readBody(req)));
      }
      if (req.method === 'PATCH' && tail === 'many') {
        const { query, data } = await readBody(req);
        return json(res, 200, store.updateMany(name, query, data));
      }
      if (req.method === 'PATCH' && tail) {
        const updated = store.update(name, tail, await readBody(req));
        return updated ? json(res, 200, updated) : json(res, 404, { error: 'Not found' });
      }
      if (req.method === 'DELETE' && tail === 'many') {
        const { query } = await readBody(req);
        return json(res, 200, store.deleteMany(name, query));
      }
      if (req.method === 'DELETE' && tail) {
        return json(res, 200, { deleted: store.delete(name, tail) });
      }
      return json(res, 405, { error: `${req.method} not supported here` });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // ── Maintenance ─────────────────────────────────────────────────────────
  // Local-only operations the hosted app never had. Deliberately NOT a
  // base44/functions entry, so a future sync from Base44 cannot clobber it and
  // it can reach the filesystem to take a snapshot first.
  if (segments[0] === 'api' && segments[1] === 'maintenance') {
    const action = segments[2];

    if (action === 'reset-info' && req.method === 'GET') {
      // So the UI can state exactly what will happen rather than guessing.
      const counts = {};
      for (const name of RESET_CLEARS) counts[name] = store.list(name, {}).length;
      return json(res, 200, { clears: RESET_CLEARS, keeps: RESET_KEEPS, counts });
    }

    if (action === 'reset' && req.method === 'POST') {
      const body = await readBody(req);

      // A typed confirmation, because this is irreversible from the UI's point
      // of view and a misclick should not be able to do it.
      if (body.confirm !== 'RESET') {
        return json(res, 400, { error: 'Confirmation text did not match.' });
      }

      // Refuse while a trading cycle holds the lease. The worker persists its
      // portfolio once at the end of a cycle from its own in-memory state, so
      // resetting mid-cycle would be silently undone seconds later.
      const settingsRows = store.list('AutoTradingSettings', {});
      const locked = settingsRows.find(
        (s2) => s2.run_lock_until && new Date(s2.run_lock_until) > new Date()
      );
      if (locked) {
        return json(res, 409, {
          error: 'A trading cycle is running right now. Wait a few seconds and try again.',
        });
      }

      let snapshot = null;
      try {
        snapshot = snapshotEntities(store);
        log.info(`Snapshot before reset: ${snapshot.path}`);
      } catch (err) {
        // No snapshot means no way back, so do not proceed.
        log.error(`Snapshot failed, refusing to reset: ${err.message}`);
        return json(res, 500, { error: `Could not take a backup first: ${err.message}. Nothing was changed.` });
      }

      const startingBalance = Number(body.startingBalance) > 0
        ? Number(body.startingBalance)
        : 10000;

      const result = resetTradingData(store, { startingBalance, log });
      return json(res, 200, { ...result, snapshot });
    }

    return json(res, 404, { error: 'Unknown maintenance action' });
  }

  // POST /api/files/upload — local file storage for the Core integrations shim
  if (segments[0] === 'api' && segments[1] === 'files' && segments[2] === 'upload') {
    return json(res, 501, { error: 'File upload is not implemented in the local build' });
  }

  // Anything not under /api is the built React app.
  return serveStatic(req, res, url);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json',
};

const DIST = path.join(ROOT, 'dist');

function serveStatic(req, res, url) {
  if (!existsSync(DIST)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('The UI has not been built yet. Run:  npm run build');
  }

  // Resolve inside dist and refuse anything that escapes it (LOCAL FIX:
  // path.relative, not a startsWith prefix — `dist` as a prefix would also
  // happily serve a hypothetical sibling `dist2`/`dist-backup` directory).
  const requested = decodeURIComponent(url.pathname);
  const relative = path.relative(DIST, path.join(DIST, requested));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  // let, not const: the SPA fallback below re-points filePath to index.html.
  let filePath = path.join(DIST, requested);

  // Single-page app: unknown paths fall back to index.html so client-side
  // routing works on a hard refresh.
  //
  // But a path with a file extension is asking for a FILE, not a route. Serving
  // index.html for a missing .json or .png produces a confusing parse error in
  // the console instead of an honest 404 — which is exactly what the missing
  // manifest.json did.
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    const looksLikeFile = /\.[a-z0-9]{2,5}$/i.test(requested);
    if (looksLikeFile) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    filePath = path.join(DIST, 'index.html');
  }

  try {
    const body = readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': body.length };
    // Hashed asset filenames are safe to cache; index.html must not be.
    if (filePath.endsWith('index.html')) headers['Cache-Control'] = 'no-cache';
    else if (requested.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    res.writeHead(200, headers);
    res.end(body);
  } catch (err) {
    res.writeHead(500); res.end('Error reading file');
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });

const { loaded, failed } = await registry.loadAll();

let scheduler = null;

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    log.error(`unhandled: ${err.message}`);
    json(res, 500, { error: 'Internal error' });
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${PORT} is already in use — is another copy of the server already running?`);
    log.error(`Stop it, or set PORT in .env to something else.`);
  } else {
    log.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log.info('─'.repeat(58));
  log.info(`CryptoMate local server — http://${HOST}:${PORT}`);
  log.info(`Build: ${BUILD}`);
  log.info(`Functions loaded: ${loaded.length}${failed.length ? `, failed: ${failed.map(([n]) => n).join(', ')}` : ''}`);
  log.info(`Data: ${DATA}`);
  log.info(auth.isConfigured
    ? `Lock: password set${auth.mfaEnabled ? ' + two-factor' : ' (two-factor off)'}`
    : 'Lock: no password yet — you will be asked to create one');
  log.info(existsSync(path.join(ROOT, 'dist'))
    ? `UI:   http://${HOST}:${PORT}`
    : 'UI:   not built yet — run `npm run build`');
  log.info('─'.repeat(58));

  // Warn about configurations that produce a busy-looking bot that never
  // trades. Both of these fail closed by design, which is correct — but silent
  // failure is how you watch a scheduler run all day and get nothing.
  try {
    for (const settings of store.list('AutoTradingSettings', {})) {
      if (!settings.is_enabled) continue;

      const aiMode = settings.ai_confirmation_mode || 'off';
      if (aiMode === 'auto' && !(process.env.LLM_PROVIDER && process.env.LLM_API_KEY)) {
        log.warn('AI confirmation is set to "auto" but no LLM provider is configured.');
        log.warn('That gate fails closed, so EVERY trade will be rejected.');
        log.warn('Fix: set LLM_PROVIDER and LLM_API_KEY in .env, or set AI confirmation to "off".');
      }
      if (aiMode === 'manual') {
        log.info('AI confirmation is "manual" — trades wait for you to approve them in the UI.');
      }
      if (settings.kill_switch_enabled) {
        log.warn('Kill switch is ON — no trading will happen until it is cleared.');
      }
    }
  } catch (err) {
    log.warn(`Could not check trading configuration: ${err.message}`);
  }

  scheduler = new Scheduler({ registry, store, log });
  scheduler.start();
});

const shutdown = (signal, exitCode = 0) => {
  log.info(`${signal} — shutting down`);
  scheduler?.stop();
  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// A crash-grade fault means the in-memory portfolio state is unreliable and
// the process has already missed at least one event. The previous behaviour
// logged and kept running, which let the bot keep placing orders on state
// nothing produced — the silent-failure mode everything else here guards
// against. So: log, stop the scheduler, and exit non-zero so the autostart
// task (or the operator) restarts a clean process. The logger writes
// synchronously (appendFileSync), so the line is on disk before exit runs.
process.on('uncaughtException', (err) => {
  log.error(`uncaught: ${err.message}\n${err.stack}`);
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  log.error(`unhandled rejection: ${reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason)}`);
  shutdown('unhandledRejection', 1);
});
