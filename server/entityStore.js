/**
 * Entity store — the local replacement for Base44's database.
 *
 * One JSON file per entity, atomic writes. Implements the query semantics the
 * app actually relies on: equality filters, sorting by field (with a leading
 * '-' for descending), and limits.
 *
 * Every record gets id, created_date, updated_date and created_by, because the
 * UI reads those fields directly and would render blanks without them.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * The single operator this app runs as.
 *
 * Stamped onto every record as created_by, and the backend functions filter on
 * it, so changing it after records exist orphans them — the server migrates
 * old records on startup rather than leaving them stranded.
 *
 * Override with OPERATOR_EMAIL in .env.
 */
export const LOCAL_USER_EMAIL = process.env.OPERATOR_EMAIL || 'kollossus55@gmail.com';

/** Emails used by earlier builds, migrated forward on startup. */
export const LEGACY_EMAILS = ['local@cryptomate'];

export class EntityStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'entities');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.cache = new Map();
  }

  _file(name) {
    // Entity names come from the URL, so refuse anything that could escape the
    // data directory.
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid entity name: ${name}`);
    }
    return path.join(this.dir, `${name}.json`);
  }

  _load(name) {
    if (this.cache.has(name)) return this.cache.get(name);

    const file = this._file(name);
    if (!existsSync(file)) {
      this.cache.set(name, []);
      return [];
    }

    try {
      const rows = JSON.parse(readFileSync(file, 'utf8'));
      const list = Array.isArray(rows) ? rows : [];
      this.cache.set(name, list);
      return list;
    } catch (err) {
      // Preserve rather than overwrite — this may be the only copy of your
      // trade history.
      const salvage = `${file}.corrupt-${Date.now()}`;
      try { copyFileSync(file, salvage); } catch { /* best effort */ }
      console.error(`[entities] ${name}.json unreadable (${err.message}); saved ${path.basename(salvage)}`);
      this.cache.set(name, []);
      return [];
    }
  }

  _save(name, rows) {
    const file = this._file(name);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
    renameSync(tmp, file); // atomic
    this.cache.set(name, rows);
  }

  /**
   * Filter rows by an equality query.
   *
   * Base44 supports richer operators, but the app only uses plain equality
   * (and the occasional `$in`), so that is what this implements. An unknown
   * operator throws rather than silently matching everything — a filter that
   * quietly stops filtering is how you end up operating on the wrong records.
   */
  _match(row, query) {
    if (!query) return true;

    for (const [key, want] of Object.entries(query)) {
      const have = row[key];

      if (want && typeof want === 'object' && !Array.isArray(want)) {
        const ops = Object.keys(want);
        for (const op of ops) {
          if (op === '$in') {
            if (!Array.isArray(want.$in) || !want.$in.includes(have)) return false;
          } else if (op === '$ne') {
            if (have === want.$ne) return false;
          } else if (op === '$gt') {
            if (!(have > want.$gt)) return false;
          } else if (op === '$gte') {
            if (!(have >= want.$gte)) return false;
          } else if (op === '$lt') {
            if (!(have < want.$lt)) return false;
          } else if (op === '$lte') {
            if (!(have <= want.$lte)) return false;
          } else {
            throw new Error(`Unsupported filter operator "${op}" on field "${key}"`);
          }
        }
        continue;
      }

      if (have !== want) return false;
    }
    return true;
  }

  _sort(rows, sort) {
    if (!sort) return rows;
    const desc = sort.startsWith('-');
    const field = desc ? sort.slice(1) : sort;

    return [...rows].sort((a, b) => {
      const x = a[field];
      const y = b[field];
      if (x === y) return 0;
      if (x === undefined || x === null) return 1;   // missing values last
      if (y === undefined || y === null) return -1;
      const cmp = x > y ? 1 : -1;
      return desc ? -cmp : cmp;
    });
  }

  list(name, { sort, limit, filter } = {}) {
    let rows = this._load(name).filter((r) => this._match(r, filter));
    rows = this._sort(rows, sort);
    if (limit) rows = rows.slice(0, Number(limit));
    return rows;
  }

  get(name, id) {
    return this._load(name).find((r) => r.id === id) || null;
  }

  create(name, data) {
    const rows = [...this._load(name)];
    const now = new Date().toISOString();
    const record = {
      ...data,
      id: data.id || randomUUID(),
      created_date: data.created_date || now,
      updated_date: now,
      created_by: data.created_by || LOCAL_USER_EMAIL,
    };
    rows.push(record);
    this._save(name, rows);
    return record;
  }

  bulkCreate(name, items) {
    const rows = [...this._load(name)];
    const now = new Date().toISOString();
    const created = items.map((data) => ({
      ...data,
      id: data.id || randomUUID(),
      created_date: data.created_date || now,
      updated_date: now,
      created_by: data.created_by || LOCAL_USER_EMAIL,
    }));
    rows.push(...created);
    this._save(name, rows);
    return created;
  }

  update(name, id, data) {
    const rows = [...this._load(name)];
    const index = rows.findIndex((r) => r.id === id);
    if (index === -1) return null;

    // id and created_date are not editable through an update.
    const { id: _ignoredId, created_date: _ignoredCreated, ...patch } = data;
    rows[index] = { ...rows[index], ...patch, id, updated_date: new Date().toISOString() };
    this._save(name, rows);
    return rows[index];
  }

  updateMany(name, query, data) {
    const rows = [...this._load(name)];
    const now = new Date().toISOString();
    let count = 0;
    for (let i = 0; i < rows.length; i++) {
      if (!this._match(rows[i], query)) continue;
      const { id: _i, created_date: _c, ...patch } = data;
      rows[i] = { ...rows[i], ...patch, updated_date: now };
      count++;
    }
    this._save(name, rows);
    return { count };
  }

  delete(name, id) {
    const rows = this._load(name);
    const next = rows.filter((r) => r.id !== id);
    if (next.length === rows.length) return false;
    this._save(name, next);
    return true;
  }

  deleteMany(name, query) {
    const rows = this._load(name);
    // A deleteMany with no query would wipe the collection. The app never does
    // that, so treat it as a bug rather than honouring it.
    if (!query || Object.keys(query).length === 0) {
      throw new Error('deleteMany requires a query — refusing to delete every record');
    }
    const next = rows.filter((r) => !this._match(r, query));
    const count = rows.length - next.length;
    this._save(name, next);
    return { count };
  }
}

/**
 * Re-stamp records created under a previous operator email.
 *
 * Without this, an email change silently hides all existing data: the records
 * are still on disk, but every function filters by created_by and finds
 * nothing. Runs once at startup and is a no-op when there is nothing to move.
 */
export function migrateOperatorEmail(store, { from = LEGACY_EMAILS, to = LOCAL_USER_EMAIL, log } = {}) {
  let moved = 0;
  let collections = 0;

  let files = [];
  try { files = readdirSync(store.dir).filter((f) => f.endsWith('.json')); } catch { return { moved: 0 }; }

  for (const file of files) {
    const name = file.replace(/\.json$/, '');
    const rows = store._load(name);
    let changed = false;

    for (const row of rows) {
      if (row.created_by && from.includes(row.created_by) && row.created_by !== to) {
        row.created_by = to;
        moved++;
        changed = true;
      }
    }

    if (changed) { store._save(name, rows); collections++; }
  }

  if (moved) log?.info(`Migrated ${moved} record(s) across ${collections} collection(s) to ${to}`);
  return { moved, collections };
}

/**
 * Make sure a User record exists for the operator.
 *
 * The admin page reads the User ENTITY (base44.entities.User.list()), which on
 * Base44 was filled in by the platform's own user table. Nothing local creates
 * it, so without this the admin page shows an empty list even though you are
 * signed in — the identity from auth.me() is a separate thing.
 *
 * Idempotent: updates the existing row rather than adding a duplicate when the
 * operator email or name changes.
 */
export function ensureOperatorUser(store, { email = LOCAL_USER_EMAIL, name, log } = {}) {
  const fullName = name || process.env.OPERATOR_NAME || 'Administrator';
  const users = store.list('User', {});

  // Match on the current email, or on a legacy one so a rename updates in place.
  const existing = users.find((u) => u.email === email)
    || users.find((u) => LEGACY_EMAILS.includes(u.email));

  if (existing) {
    const needsUpdate = existing.email !== email
      || existing.full_name !== fullName
      || existing.role !== 'admin';
    if (needsUpdate) {
      store.update('User', existing.id, { email, full_name: fullName, role: 'admin' });
      log?.info(`Updated operator user record to ${email}`);
    }
    return existing.id;
  }

  const created = store.create('User', {
    email,
    full_name: fullName,
    role: 'admin',
    created_by: email,
  });
  log?.info(`Created operator user record for ${email}`);
  return created.id;
}

/**
 * Point-in-time copy of every entity file.
 *
 * Taken automatically before a destructive reset, because "delete everything"
 * with no way back is a bad button to put in a UI. Returns the folder it wrote
 * to so the UI can tell the user where it went.
 */
export function snapshotEntities(store) {
  const dir = path.join(path.dirname(store.dir), 'snapshots');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, stamp);
  mkdirSync(target, { recursive: true });

  let copied = 0;
  for (const file of readdirSync(store.dir)) {
    if (!file.endsWith('.json')) continue;
    copyFileSync(path.join(store.dir, file), path.join(target, file));
    copied++;
  }

  // Keep the last 20 so this cannot fill the disk over time.
  const all = readdirSync(dir).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 20))) {
    try {
      const p = path.join(dir, old);
      for (const f of readdirSync(p)) rmSync(path.join(p, f));
      rmSync(p, { recursive: true, force: true });
    } catch { /* best effort */ }
  }

  return { path: target, files: copied };
}

/**
 * Clear trading history and start the paper account over.
 *
 * Deliberately explicit about what goes and what stays, rather than wiping the
 * data directory: losing the exchange connection, the signal configuration or
 * the password would turn a "start the test again" into a reinstall.
 */
export const RESET_CLEARS = [
  'Trade',
  'Notification',
  'PendingTradeApproval',
  'SignalOutcome',
  'AIAdvisorInsight',
  'ExchangeBalance',
];

export const RESET_KEEPS = [
  'AutoTradingSettings',
  'TradingPreferences',
  'AISignalConfig',
  'AIModelConfig',
  'CalibrationModel',
  'ExchangeConnection',
  'BacktestResult',
  'PriceAlert',
  'User',
];

export function resetTradingData(store, { startingBalance = 10000, log } = {}) {
  const cleared = {};

  for (const name of RESET_CLEARS) {
    const rows = store.list(name, {});
    if (rows.length) {
      store._save(name, []);
      cleared[name] = rows.length;
    }
  }

  // Portfolio back to a clean paper account.
  const portfolios = store.list('Portfolio', {});
  for (const p of portfolios) {
    store.update('Portfolio', p.id, {
      available_balance: startingBalance,
      total_balance: startingBalance,
      positions_value: 0,
      positions: [],
      total_trades: 0,
      total_profit_loss: 0,
    });
  }

  // Daily counters and the circuit breaker, which otherwise carry a stale
  // loss figure and could halt trading on a freshly reset account.
  const settings = store.list('AutoTradingSettings', {});
  for (const s of settings) {
    store.update('AutoTradingSettings', s.id, {
      trades_today: 0,
      daily_loss: 0,
      assets_traded_today: [],
      daily_counters_date: null,
      daily_start_equity: null,
      circuit_breaker_triggered_at: null,
      run_lock_until: null,
    });
  }

  log?.warn(`Trading data reset. Cleared: ${JSON.stringify(cleared)}. ` +
            `Portfolio reset to ${startingBalance}.`);

  return { cleared, portfoliosReset: portfolios.length, startingBalance };
}
