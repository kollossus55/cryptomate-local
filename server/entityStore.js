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
import { fileURLToPath } from 'node:url';

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

// BOM-tolerant: Windows tooling (PowerShell 5.1 redirects, some editors) writes UTF-8
// with a leading BOM, which JSON.parse rejects. A settings file turning "corrupt"
// because of three invisible bytes is a cruel way to lose a trading session.
function parseRows(file) {
  const rows = JSON.parse(readFileSync(file, 'utf8').replace(/^[\uFEFF]/, ''));
  if (!Array.isArray(rows)) throw new Error('the file does not hold a list');
  return rows;
}

function writeAtomic(file, rows) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
  renameSync(tmp, file);
}

// Small files that V6 cannot run safely without. Each write also refreshes a good copy,
// so damage to the file costs nothing. The large logs are not worth doubling.
const KEEP_GOOD_COPY = new Set(['Portfolio', 'V6Config', 'V6StrategyState', 'V6Certificate', 'AutoTradingSettings']);

export class EntityStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'entities');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.cache = new Map();
    this.unreadable = new Map();
    // Windows file names ignore case, so 'TRADE' and 'Trade' are one file. They must be
    // one cache too: two caches of one file write each other's stale rows over the disk.
    this.names = new Map();
    const schemas = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'base44', 'entities');
    const known = [...KEEP_GOOD_COPY, ...RESET_CLEARS, ...RESET_KEEPS, 'User'];
    try { known.push(...readdirSync(schemas).filter((f) => f.endsWith('.jsonc')).map((f) => f.replace(/\.jsonc$/, ''))); } catch { /* no schema folder in a bare copy */ }
    known.push(...readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));
    for (const name of known) if (!this.names.has(name.toLowerCase())) this.names.set(name.toLowerCase(), name);
  }

  /** The one spelling of an entity name, whatever case the caller used. */
  canonicalName(name) {
    // Entity names come from the URL, so refuse anything that could escape the
    // data directory.
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid entity name: ${name}`);
    }
    const key = name.toLowerCase();
    if (!this.names.has(key)) this.names.set(key, name);
    return this.names.get(key);
  }

  _file(name) {
    return path.join(this.dir, `${this.canonicalName(name)}.json`);
  }

  _load(name) {
    const entity = this.canonicalName(name);
    if (this.cache.has(entity)) return this.cache.get(entity);

    const file = this._file(entity);
    const good = `${file}.good`;
    const keepsCopy = KEEP_GOOD_COPY.has(entity);
    if (!existsSync(file)) {
      if (keepsCopy && existsSync(good)) return this._restore(entity, file, 'missing');
      this.cache.set(entity, []);
      return [];
    }

    let rows;
    try {
      rows = parseRows(file);
    } catch (err) {
      return this._unreadable(entity, file, err);
    }
    this.unreadable.delete(entity);
    if (keepsCopy && !existsSync(good)) writeAtomic(good, rows);
    // _save writes both files, so an empty file beside a full copy did not come from here.
    if (keepsCopy && rows.length === 0 && this._goodHasRows(good)) return this._restore(entity, file, 'empty');
    this.cache.set(entity, rows);
    return rows;
  }

  _goodHasRows(good) {
    try { return parseRows(good).length > 0; } catch { return false; }
  }

  // Unreadable is never empty: an empty answer would let a caller start the account over,
  // or write a new file over the only copy of the history.
  _unreadable(entity, file, err) {
    if (!this.unreadable.has(entity)) {
      const salvage = `${file}.corrupt-${Date.now()}`;
      try { copyFileSync(file, salvage); } catch { /* best effort */ }
      console.error(`[entities] ${entity}.json unreadable (${err.message}); saved ${path.basename(salvage)}`);
      this.unreadable.set(entity, { salvage: path.basename(salvage) });
    }
    if (KEEP_GOOD_COPY.has(entity) && existsSync(`${file}.good`)) {
      try {
        return this._restore(entity, file, 'unreadable');
      } catch (restoreErr) {
        console.error(`[entities] ${entity}.json.good is unreadable too (${restoreErr.message})`);
      }
    }
    throw Object.assign(new Error(`${entity}.json is unreadable, so nothing was read or written. Its contents are saved as ${this.unreadable.get(entity).salvage}. A person needs to repair it.`), { status: 503, code: 'ENTITY_UNREADABLE', entity });
  }

  _restore(entity, file, why) {
    const rows = parseRows(`${file}.good`);
    writeAtomic(file, rows);
    this.cache.set(entity, rows);
    this.unreadable.delete(entity);
    console.error(`[entities] ${entity}.json was ${why}; restored from its latest good copy`);
    // The engine holds new entries until the operator acknowledges this event.
    try {
      const t = Date.now();
      this.create('V6RiskEvent', {
        id: `v6e-restored-${entity}-${t}`, t, type: 'store_restored', severity: 'critical', code: 'store_restored',
        message: `${entity}.json was ${why} and has been restored from its latest good copy. New entries are held until this is acknowledged. Exits continue.`,
        data: { entity, why }, sticky: true, acked_at: null, cleared_at: null,
      });
    } catch (err) {
      console.error(`[entities] could not record the restore of ${entity}: ${err.message}`);
    }
    return rows;
  }

  _save(name, rows) {
    const entity = this.canonicalName(name);
    const file = this._file(entity);
    writeAtomic(file, rows);
    if (KEEP_GOOD_COPY.has(entity)) writeAtomic(`${file}.good`, rows);
    this.cache.set(entity, rows);
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

  /**
   * LOCAL CHANGE (agent committee): many different patches, ONE file write.
   * update() rewrites the whole collection file per call, so resolving a
   * thousand decision outcomes one by one would mean a thousand full rewrites.
   * Unknown ids are skipped and counted.
   */
  bulkUpdate(name, updates) {
    const rows = [...this._load(name)];
    const indexById = new Map(rows.map((r, i) => [r.id, i]));
    const now = new Date().toISOString();
    let updated = 0;
    let missing = 0;
    for (const { id, data } of updates || []) {
      const i = indexById.get(id);
      if (i === undefined) { missing++; continue; }
      const { id: _i, created_date: _c, ...patch } = data || {};
      rows[i] = { ...rows[i], ...patch, id, updated_date: now };
      updated++;
    }
    if (updated) this._save(name, rows);
    return { updated, missing };
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
    if (count) this._save(name, rows);
    return { count };
  }

  delete(name, id) {
    const rows = this._load(name);
    refuseV6Delete(name, rows.filter((r) => r.id === id));
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
    refuseV6Delete(name, rows.filter((r) => this._match(r, query)));
    const next = rows.filter((r) => !this._match(r, query));
    const count = rows.length - next.length;
    if (count) this._save(name, next);
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
    let rows;
    // One damaged file must not stop the server from starting. Its readers will refuse.
    try { rows = store._load(name); } catch (err) { log?.error?.(err.message); continue; }
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
  let users;
  try { users = store.list('User', {}); } catch (err) { log?.error?.(err.message); return null; }

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
  // LOCAL CHANGE: agent committee shadow log. Its legacy_traded flags refer to
  // trades a reset deletes, so it goes with them.
  'CommitteeDecision',
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
  // LOCAL CHANGE (strategy lab): separate virtual accounts, not the paper
  // portfolio — a main-account reset leaves the lab's track record running.
  'StrategyLabAccount',
  'StrategyLabTrade',
  // V6's record survives a legacy reset: its ledger, trades and events must agree.
  'V6Config',
  'V6StrategyState',
  'V6SignalTest',
  'V6RiskEvent',
  'V6ExchangeHealth',
  'V6Certificate',
  'V6EquityPoint',
];

export const V6_TRADE_EXCHANGE = 'Paper Trading (V6)';

// Entity names are compared in lower case: Windows file names are not case sensitive,
// so 'TRADE' reaches the same file as 'Trade'.
function isV6Record(name, row) {
  const entity = String(name).toLowerCase();
  if (entity === 'trade') return row.exchange === V6_TRADE_EXCHANGE;
  if (entity === 'portfolio') return Boolean(row.v6_ledger || row.v6_state);
  return false;
}

// In the store, so the browser, the entity API and every function are all covered.
function refuseV6Delete(name, rows) {
  if (!rows.some((row) => isV6Record(name, row))) return;
  throw Object.assign(new Error(`V6 records cannot be deleted: ${name} delete refused, nothing was removed.`), { status: 403 });
}

// The engine, v6Control and the certificate script all reach the store directly, so
// closing the HTTP entity API leaves every V6 entity writable by those three alone.
export const entityApiReadOnly = (name) => /^v6/i.test(String(name));

const refuseApi = (message) => {
  throw Object.assign(new Error(message), { status: 403 });
};

const asList = (body) => (Array.isArray(body) ? body : [body]);

const isV6Exchange = (value) => String(value ?? '').trim().toLowerCase() === V6_TRADE_EXCHANGE.toLowerCase();

// Without the mark: a page holding a slightly old copy has changed nothing of the engine's.
const v6Fields = (v6) => {
  if (!v6 || typeof v6 !== 'object') return JSON.stringify(v6 ?? null);
  const { lastPrice: _mark, ...rest } = v6;
  return JSON.stringify(rest);
};

function refuseEngineFields(data, current) {
  for (const key of Object.keys(data ?? {})) {
    if (/^v6/i.test(key)) refuseApi(`${key} belongs to the V6 engine and cannot be written here.`);
  }
  if (!Array.isArray(data?.positions)) return;
  const stored = new Map((current?.positions ?? []).map((p) => [p.asset_symbol, p.v6]));
  for (const p of data.positions) {
    if (p?.v6 !== undefined && v6Fields(p.v6) !== v6Fields(stored.get(p.asset_symbol))) {
      refuseApi('Position fields under v6 belong to the V6 engine and cannot be written here.');
    }
  }
}

function guardPortfolio(store, { method, tail, body }) {
  if (method === 'POST') {
    asList(body).forEach((item) => refuseEngineFields(item));
    if (store.list('Portfolio', {}).some((row) => isV6Record('Portfolio', row))) {
      refuseApi('V6 runs this account, and a second Portfolio row is not allowed.');
    }
  } else if (method === 'PATCH' && tail === 'many') {
    refuseEngineFields(body?.data);
    if (store.list('Portfolio', { filter: body?.query }).some((row) => isV6Record('Portfolio', row))) {
      refuseApi('A bulk update cannot touch the V6 account.');
    }
  } else if (method === 'PATCH') {
    refuseEngineFields(body, store.get('Portfolio', tail));
  }
}

function guardTrade(store, { method, tail, body }) {
  const v6Text = 'V6 trades are written by the engine and cannot be changed here.';
  if (method === 'POST') {
    for (const item of asList(body)) {
      // Fixed ids make the outbox repeatable, so a planted id would hide the real row.
      if (isV6Exchange(item?.exchange) || /^v6/i.test(String(item?.id ?? ''))) refuseApi(v6Text);
    }
  } else if (method === 'PATCH') {
    const many = tail === 'many';
    if (isV6Exchange((many ? body?.data : body)?.exchange)) refuseApi(v6Text);
    const targets = many ? store.list('Trade', { filter: body?.query }) : [store.get('Trade', tail)].filter(Boolean);
    if (targets.some((row) => isV6Record('Trade', row))) refuseApi(v6Text);
  }
}

// The admin page depends on this record, and role is what makes it reachable.
function guardUser(store, { method, tail, body }) {
  const many = tail === 'many';
  if (tail === 'bulk' || !tail) return;
  const targets = many
    ? store.list('User', { filter: body?.query })
    : [store.get('User', tail)].filter(Boolean);
  if (!targets.some((user) => user.email === LOCAL_USER_EMAIL)) return;
  if (method === 'DELETE') refuseApi('You cannot delete your own operator account.');
  if (method !== 'PATCH') return;
  const patch = (many ? body?.data : body) ?? {};
  if (Object.hasOwn(patch, 'role') && patch.role !== 'admin') refuseApi('You cannot remove admin from your own account.');
  if (Object.hasOwn(patch, 'email') && patch.email !== LOCAL_USER_EMAIL) refuseApi('The operator email is set in the server configuration.');
}

/**
 * Every write through /api/entities passes here, with the canonical entity name.
 * Engine-owned state is writable only by the engine and v6Control, which use the store.
 */
export function assertEntityApiWrite(store, request) {
  const { name } = request;
  if (entityApiReadOnly(name)) refuseApi(`${name} is read only here.`);
  if (name === 'Portfolio') guardPortfolio(store, request);
  else if (name === 'Trade') guardTrade(store, request);
  else if (name === 'User') guardUser(store, request);
}

export function resetTradingData(store, { startingBalance = 10000, log } = {}) {
  const cleared = {};

  for (const name of RESET_CLEARS) {
    const rows = store.list(name, {});
    const kept = name === 'Trade' ? rows.filter((r) => r.exchange === V6_TRADE_EXCHANGE) : [];
    if (rows.length > kept.length) {
      store._save(name, kept);
      cleared[name] = rows.length - kept.length;
    }
  }

  // Portfolio back to a clean paper account.
  // A row V6 runs on is left alone: rewriting its balances would leave v6_ledger
  // stale and break the identity between ledger, positions and Trade rows.
  const allPortfolios = store.list('Portfolio', {});
  const portfolios = allPortfolios.filter((p) => !p.v6_ledger && !p.v6_state);
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

  return { cleared, portfoliosReset: portfolios.length, v6PortfoliosKept: allPortfolios.length - portfolios.length, startingBalance };
}
