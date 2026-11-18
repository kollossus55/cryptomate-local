/**
 * PAPER_ONLY lock: tries to beat the lock by every route the audit lists.
 *
 * The HTTP phases boot the real server on port 8792 from a throwaway copy under
 * data/tmp/b-lock/, so its data folder and marker file are its own. A preloaded
 * mock replaces fetch and logs every outbound request; nothing leaves the
 * machine, and no .env is involved. The last phase releases the lock inside the
 * copy and shows the same attack DOES reach the mock, so "zero orders" above it
 * is a real result and not a harness that cannot see orders.
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, 'data', 'tmp', 'b-lock', 'app');
const ENTITIES = path.join(WORK, 'data', 'entities');
const MOCK_LOG = path.join(WORK, 'outbound.jsonl');
const PORT = 8792;
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'operator@test.local';
const KEY_HEX = 'ab'.repeat(32);
const PHRASE = 'I_ACCEPT_REAL_MONEY_RISK';
const ENV_NAME = 'CRYPTOMATE_PAPER_LOCK_RELEASE';
const FAKE_SECRET = Buffer.alloc(64, 7).toString('base64');

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

// Kept before anything is mocked: this one talks to the local test server only.
const http = globalThis.fetch;
const call = async (method, url, body) => {
  const res = await http(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
};
const invoke = (name, payload) => call('POST', `/api/functions/${name}`, payload);

// ---------------------------------------------------------------------------
// Isolated app copy, mock and server control
// ---------------------------------------------------------------------------

const MOCK_SOURCE = `
import { appendFileSync } from 'node:fs';
const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = String(init.method ?? input?.method ?? 'GET').toUpperCase();
  appendFileSync(process.env.MOCK_LOG, JSON.stringify({ method, host: url.hostname, path: url.pathname }) + '\\n');
  const p = url.pathname;
  if (p === '/0/public/AssetPairs') return reply({ error: [], result: { X: { lot_decimals: 8, pair_decimals: 1, ordermin: '0.0001', tick_size: '0.1' } } });
  if (p === '/0/private/Balance') return reply({ error: [], result: { ZUSD: '100' } });
  if (p === '/0/private/AddOrder') return reply({ error: [], result: { txid: ['MOCK-TX'] } });
  if (p === '/api/v5/account/balance') return reply({ code: '0', data: [{ details: [{ ccy: 'USDT', cashBal: '100' }] }] });
  if (p === '/api/v5/trade/order') return reply({ code: '0', data: [{ ordId: 'MOCK-ORD', sCode: '0' }] });
  if (p === '/api/v5/public/instruments') return reply({ code: '0', data: [] });
  if (p === '/api/v5/market/tickers') return reply({ code: '0', data: [{ instId: 'ZEC-USDT', last: '50', open24h: '100', volCcy24h: '900000000', high24h: '100', low24h: '50' }] });
  if (p === '/api/v5/market/ticker') return reply({ code: '0', data: [{ last: '50' }] });
  if (p === '/api/v5/market/books') return reply({ code: '0', data: [{ asks: [['50', '1000', '0', '1']], bids: [['50', '1000', '0', '1']] }] });
  return reply({ code: '1', msg: 'mock: no canned reply', error: ['mock'] }, 503);
};
`;

function prepareCopy() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(ENTITIES, { recursive: true });
  for (const dir of ['server', 'base44', 'shared']) {
    cpSync(path.join(ROOT, dir), path.join(WORK, dir), { recursive: true });
  }
  cpSync(path.join(ROOT, 'package.json'), path.join(WORK, 'package.json'));
  writeFileSync(path.join(WORK, 'mock-fetch.mjs'), MOCK_SOURCE);
  writeFileSync(MOCK_LOG, '');
}

const readEntity = (name) => {
  const file = path.join(ENTITIES, `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
};
const writeEntity = (name, rows) => writeFileSync(path.join(ENTITIES, `${name}.json`), JSON.stringify(rows, null, 2));

const outbound = () => readFileSync(MOCK_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ORDER = /AddOrder|EditOrder|CancelOrder|Withdraw|\/api\/v5\/trade\//i;
const orders = () => outbound().filter((r) => ORDER.test(r.path));

let child = null;
let output = '';

async function boot(extraEnv = {}) {
  output = '';
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', OPERATOR_EMAIL: EMAIL,
    EXCHANGE_ENCRYPTION_KEY: KEY_HEX, MOCK_LOG, ...extraEnv };
  if (!extraEnv[ENV_NAME]) delete env[ENV_NAME];
  for (const k of ['HEARTBEAT_URL', 'LLM_PROVIDER', 'LLM_API_KEY']) delete env[k];

  child = spawn(process.execPath,
    ['--no-warnings', '--import', pathToFileURL(path.join(WORK, 'mock-fetch.mjs')).href, path.join(WORK, 'server', 'index.js')],
    { cwd: WORK, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    // assertPaperLockAtBoot runs in the listen callback, so wait for its line.
    if (/PAPER_ONLY lock/.test(output)) {
      const res = await call('GET', '/api/health').catch(() => null);
      if (res?.json?.ok) return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${output}`);
}

async function halt() {
  if (!child) return;
  const c = child;
  child = null;
  if (c.exitCode !== null) return;
  await new Promise((resolve) => { c.once('exit', resolve); c.kill(); });
}

// ---------------------------------------------------------------------------
// In-process: fail-closed order path, then the guards, with no server
// ---------------------------------------------------------------------------

console.log('\nOrder path, before the runtime has loaded (no lock value at all)');

const seen = [];
globalThis.fetch = async (input, init = {}) => {
  seen.push(`${init.method ?? 'GET'} ${typeof input === 'string' ? input : input.url}`);
  return new Response('{}', { status: 200 });
};

register('../server/loaderHooks.js', import.meta.url);
process.env.EXCHANGE_ENCRYPTION_KEY ??= KEY_HEX;
const orderFn = (await import('../base44/functions/liveOrderExecution/entry.ts')).default;
const controlFn = (await import('../base44/functions/liveTradingControl/entry.ts')).default;
const post = (body) => new Request('http://local/x', { method: 'POST', body: JSON.stringify(body) });

await test('liveOrderExecution fails closed when the lock value is missing', async () => {
  assert.strictEqual(globalThis.__CRYPTOMATE_PAPER_LOCK__, undefined);
  const res = await orderFn(post({ connection_id: 'x', confirm_live: true }));
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).paper_lock, true);
  assert.deepStrictEqual(seen, []);
});

const runtime = await import('../server/functionRuntime.js');
const { EntityStore } = await import('../server/entityStore.js');
const { makeBase44Shim, FunctionRegistry, resolvePaperLock, paperLockFetchRefusal, installDenoShim } = runtime;
installDenoShim();

console.log('\nRelease rule');

await test('default is locked, with neither half present', () => {
  assert.strictEqual(globalThis.__CRYPTOMATE_PAPER_LOCK__.locked, true);
  assert.strictEqual(resolvePaperLock({ env: {}, root: tmpdir() }).locked, true);
});

await test('needs both halves, exact phrase, and nothing else counts', () => {
  const root = path.join(ROOT, 'data', 'tmp', 'b-lock', 'marker-case');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const marker = path.join(root, runtime.PAPER_LOCK_MARKER_FILE);
  const envOk = { [ENV_NAME]: PHRASE };

  assert.strictEqual(resolvePaperLock({ env: envOk, root }).locked, true, 'env alone');
  writeFileSync(marker, `${PHRASE}\n`);
  assert.strictEqual(resolvePaperLock({ env: {}, root }).locked, true, 'marker alone');
  for (const v of ['1', 'true', 'false', PHRASE.toLowerCase(), '']) {
    assert.strictEqual(resolvePaperLock({ env: { [ENV_NAME]: v }, root }).locked, true, `env=${v}`);
  }
  assert.strictEqual(resolvePaperLock({ env: { PAPER_ONLY: 'false', PAPER_LOCK: '0' }, root }).locked, true);
  writeFileSync(marker, 'yes');
  assert.strictEqual(resolvePaperLock({ env: envOk, root }).locked, true, 'wrong marker text');
  writeFileSync(marker, `${PHRASE}\n`);
  assert.strictEqual(resolvePaperLock({ env: envOk, root }).locked, false, 'both');
  rmSync(root, { recursive: true, force: true });
});

await test('cannot be released at run time: env write, global overwrite, object edit', () => {
  process.env[ENV_NAME] = PHRASE;
  globalThis.Deno.env.set(ENV_NAME, PHRASE);
  assert.strictEqual(globalThis.__CRYPTOMATE_PAPER_LOCK__.locked, true);
  assert.throws(() => { 'use strict'; globalThis.__CRYPTOMATE_PAPER_LOCK__.locked = false; });
  assert.throws(() => Object.defineProperty(globalThis, '__CRYPTOMATE_PAPER_LOCK__', { value: { locked: false } }));
  assert.strictEqual(runtime.paperLockRefusal('liveOrderExecution', {}) !== null, true);
  delete process.env[ENV_NAME];
});

console.log('\nFunction denylist');

await test('registry refuses each live function and never imports the order function', async () => {
  const log = { info() {}, warn() {}, error() {} };
  const registry = new FunctionRegistry({ functionsDir: path.join(ROOT, 'base44', 'functions'), log });
  await registry.loadAll();
  assert.strictEqual(registry.handlers.has('liveOrderExecution'), false, 'handler must not exist');
  assert.ok(registry.handlers.has('exchangeCredentials'), 'read-only testing must stay loaded');

  for (const [name, payload] of [
    ['liveOrderExecution', { confirm_live: true }],
    ['liveOrderExecution', { action: 'disable', dry_run: true }],
    ['liveTradingControl', { action: 'request' }],
    ['liveTradingControl', { action: 'enable' }],
    ['liveTradingControl', { action: ['disable'] }],
    ['liveTradingControl', {}],
  ]) {
    await assert.rejects(registry.invoke(name, payload), (e) => e.status === 403, `${name} ${JSON.stringify(payload)}`);
  }
});

await test('function-to-function invoke is refused too', async () => {
  const log = { info() {}, warn() {}, error() {} };
  const dir = path.join(ROOT, 'data', 'tmp', 'b-lock', 'ff');
  const registry = new FunctionRegistry({ functionsDir: path.join(ROOT, 'base44', 'functions'), log });
  const client = makeBase44Shim(new EntityStore(dir), { getRegistry: () => registry });
  await assert.rejects(client.asServiceRole.functions.invoke('liveOrderExecution', { confirm_live: true }),
    (e) => e.response?.status === 403);
  rmSync(dir, { recursive: true, force: true });
});

await test('liveTradingControl refuses arming by itself, with the denylist bypassed', async () => {
  const dir = path.join(ROOT, 'data', 'tmp', 'b-lock', 'ctl');
  globalThis.__CRYPTOMATE_BASE44__ = makeBase44Shim(new EntityStore(dir), {});
  for (const action of ['request', 'enable']) {
    const res = await controlFn(post({ action }));
    assert.strictEqual(res.status, 403, action);
    assert.strictEqual((await res.json()).paper_lock, true);
  }
  rmSync(dir, { recursive: true, force: true });
});

console.log('\nOutbound tripwire (a future caller signing its own order)');

await test('signed order requests never reach fetch', async () => {
  seen.length = 0;
  const attempts = [
    ['https://api.kraken.com/0/private/AddOrder', { method: 'POST', body: 'x' }],
    ['https://api.kraken.com/0/private/addorder', { method: 'POST' }],
    ['https://api.kraken.com/0/private/WithdrawCancel', { method: 'POST' }],
    ['https://futures.kraken.com/0/private/AddOrder', { method: 'POST' }],
    ['https://www.okx.com/api/v5/trade/order', { method: 'POST', headers: { 'ok-access-sign': 's' } }],
    ['https://www.okx.com/api/v5/trade/batch-orders', { method: 'POST' }],
    ['https://my.okx.com/api/v5/trade/order', { method: 'POST' }],
    ['https://www.okx.com/api/v5/trade/orders-pending', { headers: { 'OK-ACCESS-SIGN': 's' } }],
    ['https://api.binance.com/api/v3/order', { method: 'POST' }],
    [new Request('https://api.kraken.com/0/private/AddOrder', { method: 'POST', body: 'x' }), undefined],
    [new URL('https://api.kraken.com/0/private/AddOrder'), { method: 'POST' }],
  ];
  for (const [input, init] of attempts) {
    await assert.rejects(globalThis.fetch(input, init), (e) => e.paperLock === true, String(input.url ?? input));
  }
  assert.deepStrictEqual(seen, []);
});

await test('read-only and public requests still pass', async () => {
  seen.length = 0;
  await globalThis.fetch('https://api.kraken.com/0/private/Balance', { method: 'POST' });
  await globalThis.fetch('https://www.okx.com/api/v5/account/balance', { headers: { 'OK-ACCESS-SIGN': 's' } });
  await globalThis.fetch('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
  await globalThis.fetch('https://api.kraken.com/0/public/AssetPairs');
  await globalThis.fetch('https://api.anthropic.com/v1/messages', { method: 'POST' });
  assert.strictEqual(seen.length, 5);
  assert.strictEqual(paperLockFetchRefusal('not a url'), null);
});

console.log('\nEntity writes through functions');

await test('a function cannot write arming fields by any store method', async () => {
  const dir = path.join(ROOT, 'data', 'tmp', 'b-lock', 'ent');
  rmSync(dir, { recursive: true, force: true });
  const store = new EntityStore(dir);
  const client = makeBase44Shim(store, {});
  const S = client.asServiceRole.entities.AutoTradingSettings;
  const C = client.asServiceRole.entities.ExchangeConnection;
  const row = await S.create({ is_enabled: false });
  const conn = await C.create({ exchange_name: 'kraken', trading_mode: 'simulated' });
  const backdate = '2020-01-01T00:00:00.000Z';
  const denied = (e) => e.status === 403;

  await assert.rejects(S.update(row.id, { live_trading_enabled: true }), denied);
  await assert.rejects(S.update(row.id, { live_trading_requested_at: backdate }), denied);
  await assert.rejects(S.update(row.id, { exchange_connection_id: conn.id }), denied);
  await assert.rejects(S.update(row.id, { live_trading_enabled: 'false' }), denied, 'a truthy string');
  await assert.rejects(S.create({ live_trading_enabled: true }), denied);
  await assert.rejects(S.bulkCreate([{ is_enabled: false }, { live_trading_enabled: true }]), denied);
  await assert.rejects(S.bulkUpdate([{ id: row.id, data: { live_trading_enabled: true } }]), denied);
  await assert.rejects(S.updateMany({ id: row.id }, { live_trading_requested_at: backdate }), denied);
  await assert.rejects(C.update(conn.id, { trading_mode: 'ready_for_live' }), denied);
  await assert.rejects(client.entities.autotradingsettings.update(row.id, { live_trading_enabled: true }), denied,
    'lower-case name is the same file on Windows');

  await S.update(row.id, { is_enabled: true, kill_switch_enabled: true, live_trading_enabled: false });
  assert.strictEqual(store.get('AutoTradingSettings', row.id).kill_switch_enabled, true, 'safe writes pass');
  assert.strictEqual(store.list('AutoTradingSettings').length, 1, 'refused bulk wrote nothing');
  rmSync(dir, { recursive: true, force: true });
});

console.log('\nSource checks');

await test('no signed order endpoint exists outside liveOrderExecution', () => {
  const allowed = new Set(['base44/functions/liveOrderExecution/entry.ts', 'server/functionRuntime.js']);
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(path.join(ROOT, rel)).isDirectory()) { walk(rel); continue; }
      if (!/\.(ts|js|jsx|mjs)$/.test(name) || allowed.has(rel)) continue;
      if (/\/0\/private\/(?!Balance)|AddOrder|\/api\/v5\/trade\/|\/api\/v3\/order/.test(readFileSync(path.join(ROOT, rel), 'utf8'))) hits.push(rel);
    }
  };
  for (const dir of ['base44', 'server', 'shared', 'src', 'scripts']) walk(dir);
  assert.deepStrictEqual(hits, []);
});

await test('Trading page: paper label shown, no live path while locked', () => {
  const src = readFileSync(path.join(ROOT, 'src/pages/Trading.jsx'), 'utf8');
  assert.match(src, /paperLock\?\.locked !== false/, 'must default to locked');
  assert.match(src, /onExecuteLiveTrade=\{paperLocked \? undefined : handleExecuteLiveTrade\}/);
  assert.match(src, /liveTradingEnabled=\{!paperLocked && /);
  assert.match(src, /\{!paperLocked && \(\s*<div className="mb-6">\s*<LiveTradingPanel \/>/);
  assert.match(src, /Paper lock is on: every order on this page is simulated/);
});

await test('every changed legacy file carries a LOCAL CHANGE comment', () => {
  for (const f of ['server/functionRuntime.js', 'server/index.js', 'src/pages/Trading.jsx',
    'base44/functions/liveOrderExecution/entry.ts', 'base44/functions/executeApprovedTrade/entry.ts',
    'base44/functions/liveTradingControl/entry.ts']) {
    assert.match(readFileSync(path.join(ROOT, f), 'utf8'), /LOCAL CHANGE: .*PAPER_ONLY/, f);
  }
});

// ---------------------------------------------------------------------------
// Real server
// ---------------------------------------------------------------------------

const { signApproval } = await import('../base44/shared/approvalProvenance.ts');

try {
  prepareCopy();

  console.log('\nServer, locked, clean data: storing fake keys and backdating over HTTP');
  await boot();

  await test('boot records the lock and health reports it', async () => {
    assert.match(output, /PAPER_ONLY lock: ON/);
    const { json } = await call('GET', '/api/health');
    assert.deepStrictEqual(json.paperLock, { locked: true, liveStateFound: [] });
    assert.ok(json.scheduler, 'scheduler must be running');
  });

  let kraken, okxLive, okxDemo;
  await test('fake keys can be stored: read-only validation still works', async () => {
    const k = await invoke('exchangeCredentials', { action: 'store', exchange_name: 'kraken', api_key: 'FAKEKRAKENKEY', api_secret: FAKE_SECRET });
    const l = await invoke('exchangeCredentials', { action: 'store', exchange_name: 'okx', api_key: 'FAKEOKXKEY01', api_secret: 'fake', api_passphrase: 'fake', is_testnet: false });
    const d = await invoke('exchangeCredentials', { action: 'store', exchange_name: 'okx', api_key: 'FAKEOKXKEY02', api_secret: 'fake', api_passphrase: 'fake', is_testnet: true });
    assert.strictEqual(k.json?.success, true, JSON.stringify(k.json));
    assert.strictEqual(l.json?.success, true, JSON.stringify(l.json));
    assert.strictEqual(d.json?.success, true, JSON.stringify(d.json));
    [kraken, okxLive, okxDemo] = [k.json.connection.id, l.json.connection.id, d.json.connection.id];
  });

  await test('credential test and balance read work and send no order', async () => {
    for (const id of [kraken, okxLive]) {
      const t = await invoke('exchangeCredentials', { action: 'test', connection_id: id });
      assert.strictEqual(t.json?.success, true, JSON.stringify(t.json));
      const b = await invoke('exchangeCredentials', { action: 'fetchBalances', connection_id: id });
      assert.strictEqual(b.json?.success, true, JSON.stringify(b.json));
    }
    assert.ok(outbound().length >= 4, 'the mock must have seen the Balance calls');
    assert.deepStrictEqual(orders(), []);
  });

  await test('Trading page manual order with one stored key: refused, no arming needed to test it', async () => {
    const res = await invoke('liveOrderExecution', { connection_id: kraken, asset_symbol: 'BTC/USDT', side: 'buy', order_type: 'market', quantity: 1, confirm_live: true });
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(orders(), []);
  });

  await test('entity API cannot arm: create, bulk, patch, many, lower-case name', async () => {
    const seed = await call('POST', '/api/entities/AutoTradingSettings', { is_enabled: false, created_by: EMAIL });
    assert.strictEqual(seed.status, 200);
    const id = seed.json.id;
    const arm = { live_trading_enabled: true, live_trading_requested_at: '2020-01-01T00:00:00.000Z', exchange_connection_id: kraken };

    const attempts = [
      ['POST', '/api/entities/AutoTradingSettings', arm],
      ['POST', '/api/entities/AutoTradingSettings/bulk', [arm]],
      ['PATCH', `/api/entities/AutoTradingSettings/${id}`, arm],
      ['PATCH', `/api/entities/AutoTradingSettings/${id}`, { live_trading_requested_at: arm.live_trading_requested_at }],
      ['PATCH', '/api/entities/AutoTradingSettings/many', { query: { id }, data: arm }],
      ['PATCH', `/api/entities/autotradingsettings/${id}`, { live_trading_enabled: true }],
      ['POST', '/api/entities/AUTOTRADINGSETTINGS', arm],
      ['PATCH', `/api/entities/ExchangeConnection/${kraken}`, { trading_mode: 'ready_for_live' }],
      ['PATCH', '/api/entities/ExchangeConnection/many', { query: { id: kraken }, data: { trading_mode: 'ready_for_live' } }],
      ['POST', '/api/entities/ExchangeConnection', { exchange_name: 'kraken', trading_mode: 'ready_for_live' }],
    ];
    for (const [method, url, body] of attempts) {
      const res = await call(method, url, body);
      assert.strictEqual(res.status, 403, `${method} ${url} -> ${res.status}`);
    }

    for (const file of readdirSync(ENTITIES)) {
      const text = readFileSync(path.join(ENTITIES, file), 'utf8');
      assert.doesNotMatch(text, /2020-01-01|ready_for_live|"live_trading_enabled": true/, file);
    }
  });

  await test('a stale settings page can still save the kill switch; the stale id is not written', async () => {
    const seed = await call('POST', '/api/entities/AutoTradingSettings', { is_enabled: false, created_by: EMAIL, exchange_connection_id: null });
    assert.strictEqual(seed.status, 200);
    const id = seed.json.id;
    // The page loaded before liveTradingControl 'cancel' cleared the connection id.
    const stale = { ...seed.json, exchange_connection_id: kraken, kill_switch_enabled: true };
    const res = await call('PATCH', `/api/entities/AutoTradingSettings/${id}`, stale);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const row = readEntity('AutoTradingSettings').find((r) => r.id === id);
    assert.strictEqual(row.kill_switch_enabled, true, 'kill switch stored');
    assert.strictEqual(row.exchange_connection_id, null, 'stale arming value not written');
    const only = await call('PATCH', `/api/entities/AutoTradingSettings/${id}`, { exchange_connection_id: kraken });
    assert.strictEqual(only.status, 403, 'an update of arming fields alone is still refused');
  });

  await test('no HTTP route releases the lock', async () => {
    await invoke('exchangeCredentials', { action: 'unlock', [ENV_NAME]: PHRASE });
    await call('POST', '/api/paper-lock', { locked: false });
    await call('POST', '/api/entities/PaperLock', { locked: false });
    await call('POST', `/api/entities/${'PAPER_LOCK_RELEASED'}`, { phrase: PHRASE });
    const { json } = await call('GET', '/api/health');
    assert.strictEqual(json.paperLock.locked, true);
    assert.strictEqual(existsSync(path.join(WORK, 'PAPER_LOCK_RELEASED')), false);
  });

  await halt();

  // Live state that got in some other way: a hand edit, or an older build.
  const armData = () => {
    const past = new Date(Date.now() - 48 * 3600e3).toISOString();
    const settings = readEntity('AutoTradingSettings');
    Object.assign(settings[0], {
      is_enabled: true, created_by: EMAIL, live_trading_enabled: true, live_trading_requested_at: past,
      exchange_connection_id: kraken, stop_loss_percent: 3, ai_confirmation_mode: 'off', run_lock_until: null,
    });
    writeEntity('AutoTradingSettings', settings);
    writeEntity('ExchangeConnection', readEntity('ExchangeConnection').map((c) => ({ ...c, trading_mode: 'ready_for_live' })));
    writeEntity('Portfolio', [{
      id: 'pf1', created_by: EMAIL, total_balance: 10000, available_balance: 9900, total_trades: 1,
      positions: [{ asset_symbol: 'ZECUSDT', quantity: 1, avg_entry_price: 100, last_known_price: 100, current_value: 100, highest_price: 100 }],
    }]);
    const approval = {
      id: 'ap1', created_by: EMAIL, owner_email: EMAIL, asset_symbol: 'ZECUSDT', signal_strength: 90, entry_price: 50,
      position_size_usdt: 100, candle_interval: '4h', status: 'pending',
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
    };
    approval.provenance_token = signApproval(approval, KEY_HEX);
    writeEntity('PendingTradeApproval', [approval]);
    writeFileSync(MOCK_LOG, '');
  };
  armData();

  console.log('\nServer, locked, fully armed data on disk (48h old request, ready_for_live, stored keys)');
  await boot();

  await test('startup assertion is loud and the server stays up with the scheduler on', async () => {
    assert.match(output, /LIVE STATE FOUND while PAPER_ONLY is on/);
    assert.match(output, /AutoTradingSettings\.live_trading_enabled/);
    assert.match(output, /ExchangeConnection\.trading_mode/);
    assert.match(output, /Refusing to arm/);
    const { json } = await call('GET', '/api/health');
    assert.strictEqual(json.paperLock.locked, true);
    assert.ok(json.paperLock.liveStateFound.length >= 4, JSON.stringify(json.paperLock));
    assert.ok(json.scheduler.jobs.length > 0);
    assert.strictEqual(child.exitCode, null);
  });

  await test('stored live state is left as found, so the V6 banner stays truthful', () => {
    assert.strictEqual(readEntity('AutoTradingSettings')[0].live_trading_enabled, true);
  });

  await test('worker with armed settings: the paper stop still fires, zero orders', async () => {
    const settings = readEntity('AutoTradingSettings')[0];
    const res = await invoke('autoTradingWorker', { settings_id: settings.id, user_email: EMAIL });
    assert.strictEqual(res.json?.success, true, JSON.stringify(res.json));
    assert.ok(res.json.trades?.some((a) => a.action === 'sell' && a.symbol === 'ZECUSDT'), JSON.stringify(res.json));
    assert.deepStrictEqual(readEntity('Portfolio')[0].positions, [], 'position must be closed');
    assert.deepStrictEqual(orders(), []);
  });

  await test('executeApprovedTrade with armed settings: fills as paper, zero orders', async () => {
    const res = await invoke('executeApprovedTrade', { approval_id: 'ap1', action: 'approve' });
    assert.strictEqual(res.json?.success, true, JSON.stringify(res.json));
    const row = readEntity('PendingTradeApproval')[0];
    assert.strictEqual(row.execution_result.exchange, 'Paper Trading (Manual Approve)');
    assert.deepStrictEqual(orders(), []);
  });

  await test('order function refused for Kraken, OKX live, OKX demo and dry run', async () => {
    const order = { asset_symbol: 'BTC/USDT', side: 'buy', order_type: 'market', quantity: 1, confirm_live: true };
    for (const payload of [
      { ...order, connection_id: kraken },
      { ...order, connection_id: okxLive },
      { ...order, connection_id: okxDemo },
      { ...order, connection_id: kraken, dry_run: true },
      { ...order, connection_id: kraken, order_type: 'limit', price: 1 },
      { ...order, connection_id: kraken, user_email: EMAIL, side: 'sell' },
    ]) {
      const res = await invoke('liveOrderExecution', payload);
      assert.strictEqual(res.status, 403, JSON.stringify(payload));
    }
    assert.strictEqual((await call('POST', '/api/functions/liveOrderExecution/', { ...order, connection_id: kraken })).status, 403, 'trailing slash');
    assert.deepStrictEqual(orders(), []);
  });

  await test('arming function refused for request and enable', async () => {
    for (const action of ['request', 'enable']) {
      assert.strictEqual((await invoke('liveTradingControl', { action })).status, 403, action);
    }
  });

  await test('entity API cannot change the armed values either', async () => {
    const id = readEntity('AutoTradingSettings')[0].id;
    const res = await call('PATCH', `/api/entities/AutoTradingSettings/${id}`, { live_trading_requested_at: '2020-01-01T00:00:00.000Z' });
    assert.strictEqual(res.status, 403);
  });

  await test('a whole-row settings save still works, so a kill switch can be set', async () => {
    const row = readEntity('AutoTradingSettings')[0];
    const res = await call('PATCH', `/api/entities/AutoTradingSettings/${row.id}`, { ...row, kill_switch_enabled: true });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(readEntity('AutoTradingSettings')[0].kill_switch_enabled, true);
    await call('PATCH', `/api/entities/AutoTradingSettings/${row.id}`, { kill_switch_enabled: false });
  });

  await test('disarming is allowed while locked and clears the state', async () => {
    const res = await invoke('liveTradingControl', { action: 'cancel' });
    assert.strictEqual(res.json?.success, true, JSON.stringify(res.json));
    const row = readEntity('AutoTradingSettings')[0];
    assert.strictEqual(row.live_trading_enabled, false);
    assert.strictEqual(row.live_trading_requested_at, null);
    assert.strictEqual(row.exchange_connection_id, null);
  });

  await test('after every attack: outbound log holds zero order requests', () => {
    assert.ok(outbound().length > 0, 'the mock must have seen traffic');
    assert.deepStrictEqual(orders(), []);
  });

  await halt();

  console.log('\nServer with only half the release');
  await boot({ [ENV_NAME]: PHRASE });
  await test('env var alone: stays locked and says so in the log', async () => {
    assert.match(output, /only the env var is set/);
    assert.strictEqual((await call('GET', '/api/health')).json.paperLock.locked, true);
    assert.strictEqual((await invoke('liveOrderExecution', { connection_id: kraken })).status, 403);
  });
  await halt();

  // Control: everything below goes to the mock only. It proves the assertions
  // above could have failed.
  console.log('\nControl: lock released inside the copy, mock fetch still catches everything');
  armData();
  writeFileSync(path.join(WORK, 'PAPER_LOCK_RELEASED'), `${PHRASE}\n`);
  await boot({ [ENV_NAME]: PHRASE });

  await test('release is recorded loudly at boot', async () => {
    assert.match(output, /PAPER_ONLY lock RELEASED/);
    assert.strictEqual((await call('GET', '/api/health')).json.paperLock.locked, false);
  });

  await test('the same Kraken attack now reaches the mock AddOrder', async () => {
    await invoke('liveOrderExecution', { connection_id: kraken, asset_symbol: 'BTC/USDT', side: 'buy', order_type: 'market', quantity: 1, confirm_live: true });
    assert.ok(orders().some((r) => r.path === '/0/private/AddOrder'), JSON.stringify(outbound()));
  });
} finally {
  await halt();
  rmSync(WORK, { recursive: true, force: true });
}

console.log('\n----------------------------------------------------');
console.log(`${passed} passed, ${failed} failed`);
console.log('----------------------------------------------------');
process.exit(failed ? 1 : 0);
