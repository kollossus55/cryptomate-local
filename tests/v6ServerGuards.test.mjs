/**
 * The HTTP boundary around V6: boots the real server on port 8791 from a throwaway copy
 * under data/tmp, with outbound fetch mocked, no .env and no keys. Built from the review
 * scripts in data/tmp/review-sec.
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'data', 'tmp', 'v6-guards', 'app');
const ENTITIES = path.join(APP, 'data', 'entities');
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const EMAIL = 'operator@test.local';
const V6 = 'Paper Trading (V6)';

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.stack}`); }
};

const MOCK = `globalThis.fetch = async () => { throw new Error('mock: offline'); };\n`;

let child = null;

async function boot() {
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(ENTITIES, { recursive: true });
  for (const d of ['server', 'base44', 'shared']) cpSync(path.join(ROOT, d), path.join(APP, d), { recursive: true });
  cpSync(path.join(ROOT, 'package.json'), path.join(APP, 'package.json'));
  writeFileSync(path.join(APP, 'mock.mjs'), MOCK);
  mkdirSync(path.join(APP, 'dist'), { recursive: true });
  writeFileSync(path.join(APP, 'dist', 'index.html'), '<html>ui</html>');
  await start();
}

async function start() {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', OPERATOR_EMAIL: EMAIL };
  for (const k of Object.keys(env)) if (/^(LLM_|EXCHANGE_ENCRYPTION|CRYPTOMATE_)/.test(k)) delete env[k];
  child = spawn(process.execPath, ['--no-warnings', '--import', pathToFileURL(path.join(APP, 'mock.mjs')).href, path.join(APP, 'server', 'index.js')],
    { cwd: APP, env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('the server did not start');
}

async function stop() {
  if (!child) return;
  const c = child;
  child = null;
  await new Promise((r) => { c.once('exit', r); c.kill(); setTimeout(r, 2500); });
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { s: res.status, j: json, h: res.headers };
}

const rows = async (name) => (await api('GET', `/api/entities/${name}`)).j;
const disk = (name) => JSON.parse(readFileSync(path.join(ENTITIES, `${name}.json`), 'utf8'));
const cycle = () => api('POST', '/api/functions/v6Engine', {});
const control = (body) => api('POST', '/api/functions/v6Control', body);

try {
  await boot();

  console.log('\nBefore cutover, legacy pages work as they did');

  await test('the legacy page can create its account and write its fields', async () => {
    const created = await api('POST', '/api/entities/Portfolio', { total_balance: 10000, available_balance: 10000, positions: [], total_profit_loss: 0, total_trades: 0 });
    assert.strictEqual(created.s, 200);
    const edited = await api('PATCH', `/api/entities/Portfolio/${created.j.id}`, { available_balance: 9000, total_trades: 1 });
    assert.strictEqual(edited.s, 200);
    await api('PATCH', `/api/entities/Portfolio/${created.j.id}`, { available_balance: 10000, total_trades: 0 });
  });

  await test('ordinary trades can still be created and changed', async () => {
    assert.strictEqual((await api('POST', '/api/entities/Trade', { id: 'legacy1', exchange: 'Paper Trading', asset_symbol: 'BTC' })).s, 200);
    assert.strictEqual((await api('PATCH', '/api/entities/Trade/legacy1', { notes: 'x' })).s, 200);
    assert.strictEqual((await api('DELETE', '/api/entities/Trade/legacy1')).s, 200);
  });

  const first = await cycle();
  assert.strictEqual(first.j?.status, 'ran', `setup: ${JSON.stringify(first.j)}`);
  const account = (await rows('Portfolio'))[0];
  const cfg = (await rows('V6Config'))[0];

  console.log('\nEngine state through the entity API');

  await test('the cycle pins the account', async () => {
    assert.strictEqual(cfg.portfolio_id, account.id);
    assert.ok(Number.isFinite(cfg.cutover_at));
  });

  await test('every V6 entity refuses every write, in any letter case', async () => {
    for (const name of ['V6Config', 'v6config', 'V6CONFIG', 'V6Certificate', 'v6certificate', 'V6StrategyState', 'V6RiskEvent', 'V6SignalTest', 'V6EquityPoint', 'V6ExchangeHealth']) {
      for (const [method, tail, body] of [['POST', '', {}], ['POST', '/bulk', [{}]], ['PATCH', `/${cfg.id}`, { engine_lease: null }], ['PATCH', '/many', { query: {}, data: {} }], ['DELETE', `/${cfg.id}`, undefined], ['DELETE', '/many', { query: { id: 'x' } }]]) {
        assert.strictEqual((await api(method, `/api/entities/${name}${tail}`, body)).s, 403, `${method} ${name}${tail}`);
      }
    }
    assert.strictEqual((await rows('V6Config')).length, 1);
  });

  await test('reads of V6 entities still work', async () => {
    assert.strictEqual((await api('GET', '/api/entities/V6Config')).s, 200);
  });

  await test('engine fields on Portfolio are refused however they arrive', async () => {
    const url = `/api/entities/Portfolio/${account.id}`;
    for (const body of [{ v6_state: null }, { v6_ledger: null }, { v6_state: { outbox: [] } }, { V6_STATE: {} }, { v6_anything: 1 }]) {
      assert.strictEqual((await api('PATCH', url, body)).s, 403, JSON.stringify(body));
    }
    assert.strictEqual((await api('PATCH', '/api/entities/portfolio/many', { query: { id: account.id }, data: { v6_state: null } })).s, 403);
    assert.strictEqual((await api('PATCH', '/api/entities/PORTFOLIO/many', { query: { id: account.id }, data: { total_trades: 5 } })).s, 403);
    assert.ok(disk('Portfolio')[0].v6_state, 'the state must still be there');
  });

  await test('a position cannot carry forged engine fields', async () => {
    const res = await api('PATCH', `/api/entities/Portfolio/${account.id}`, { positions: [{ asset_symbol: 'ETHUSDT', quantity: 1, v6: { stopPrice: 1 } }] });
    assert.strictEqual(res.s, 403);
  });

  await test('no second Portfolio row while V6 runs the account', async () => {
    assert.strictEqual((await api('POST', '/api/entities/Portfolio', { total_balance: 1 })).s, 403);
    assert.strictEqual((await api('POST', '/api/entities/Portfolio/bulk', [{ total_balance: 1 }])).s, 403);
    assert.strictEqual((await api('POST', '/api/entities/Portfolio', { id: 'evil', v6_state: {} })).s, 403);
    assert.strictEqual((await rows('Portfolio')).length, 1);
  });

  await test('the account row cannot be deleted', async () => {
    assert.strictEqual((await api('DELETE', `/api/entities/Portfolio/${account.id}`)).s, 403);
    assert.strictEqual((await api('DELETE', '/api/entities/PORTFOLIO/many', { query: { id: account.id } })).s, 403);
  });

  await test('a legacy balance write answers 200, is undone by the next cycle and raises the alarm', async () => {
    const before = (await rows('Portfolio'))[0].available_balance;
    assert.strictEqual((await api('PATCH', `/api/entities/Portfolio/${account.id}`, { available_balance: 900000, total_balance: 900000 })).s, 200);
    await cycle();
    await cycle();
    const after = (await rows('Portfolio'))[0];
    assert.strictEqual(after.available_balance, before);
    assert.strictEqual(after.v6_state.lastCycle.cash_code, 'foreign_change');
    const alarm = (await rows('V6RiskEvent')).find((e) => e.code === 'foreign_change');
    assert.strictEqual(alarm.severity, 'critical');
    assert.strictEqual((await control({ action: 'ackEvent', id: alarm.id })).s, 200);
    await cycle();
    assert.notStrictEqual((await rows('Portfolio'))[0].v6_state.lastCycle.cash_code, 'foreign_change');
  });

  await test('recutover is refused on an account that still has its state', async () => {
    assert.strictEqual((await control({ action: 'recutover' })).j?.code ?? (await control({ action: 'recutover' })).j?.error?.code, 'CONFIRM_MISMATCH');
    const res = await control({ action: 'recutover', confirm: 'RECUTOVER' });
    assert.strictEqual(res.j?.code ?? res.j?.error?.code, 'NOT_ALLOWED_IN_STATE');
    assert.strictEqual((await rows('V6Config'))[0].recutover_request ?? null, null);
  });

  console.log('\nV6 trades');

  await test('a V6 trade cannot be created, re-labelled or rewritten through the API', async () => {
    assert.strictEqual((await api('POST', '/api/entities/Trade', { exchange: V6 })).s, 403);
    assert.strictEqual((await api('POST', '/api/entities/trade/bulk', [{ exchange: V6.toLowerCase() }])).s, 403);
    assert.strictEqual((await api('POST', '/api/entities/Trade', { id: 'v6t-planted', exchange: 'x' })).s, 403, 'a planted id would hide the real row');
    // The engine writes these through the store, so plant one on disk for the next start.
    await stop();
    const trades = existsSync(path.join(ENTITIES, 'Trade.json')) ? disk('Trade') : [];
    writeFileSync(path.join(ENTITIES, 'Trade.json'), JSON.stringify([...trades, { id: 'v6t-1', exchange: V6, profit_loss: 1 }]));
    await start();
    for (const name of ['Trade', 'TRADE', 'tRaDe']) {
      assert.strictEqual((await api('DELETE', `/api/entities/${name}/v6t-1`)).s, 403, name);
      assert.strictEqual((await api('PATCH', `/api/entities/${name}/v6t-1`, { exchange: 'x' })).s, 403, name);
      assert.strictEqual((await api('PATCH', `/api/entities/${name}/v6t-1`, { profit_loss: 9999 })).s, 403, name);
    }
    assert.strictEqual((await api('PATCH', '/api/entities/Trade/many', { query: { id: 'v6t-1' }, data: { exchange: 'x' } })).s, 403);
    assert.strictEqual((await api('PATCH', '/api/entities/Trade/many', { query: {}, data: { exchange: V6 } })).s, 403);
    assert.strictEqual((await api('DELETE', '/api/entities/Trade/many', { query: { exchange: { $gte: '' } } })).s, 403);
    assert.strictEqual(disk('Trade').find((t) => t.id === 'v6t-1').profit_loss, 1);
  });

  console.log('\nOne name, one cache, one file');

  await test('a stale spelling can no longer roll a file back', async () => {
    await api('GET', '/api/entities/tRADE');
    await api('POST', '/api/entities/Trade', { id: 'fresh1', exchange: 'Paper Trading' });
    await api('DELETE', '/api/entities/tRADE/many', { query: { id: 'nomatch' } });
    assert.ok(disk('Trade').some((t) => t.id === 'fresh1'));
    await api('GET', '/api/entities/PORTFOLIO');
    await cycle();
    const seq = (await rows('Portfolio'))[0].v6_state.seq;
    await api('PATCH', '/api/entities/PORTFOLIO/many', { query: { id: 'nomatch' }, data: { x: 1 } });
    assert.strictEqual(disk('Portfolio')[0].v6_state.seq, seq);
    assert.strictEqual(readdirSync(ENTITIES).filter((f) => /^trade\.json$/i.test(f)).length, 1);
  });

  console.log('\nThe operator account');

  await test('the operator cannot be demoted, renamed or deleted by any route', async () => {
    const user = (await rows('User')).find((u) => u.email === EMAIL);
    for (const name of ['User', 'user', 'USER']) {
      for (const role of ['user', '', null]) {
        const res = await api('PATCH', `/api/entities/${name}/${user.id}`, { role });
        assert.ok(res.s >= 400, `${name} role ${role}`);
      }
      assert.ok((await api('DELETE', `/api/entities/${name}/${user.id}`)).s >= 400, name);
      assert.ok((await api('PATCH', `/api/entities/${name}/${user.id}`, { email: 'other@x' })).s >= 400, name);
    }
    assert.ok((await api('PATCH', '/api/entities/User/many', { query: { email: EMAIL }, data: { role: 'user' } })).s >= 400);
    assert.ok((await api('DELETE', '/api/entities/user/many', { query: { email: EMAIL } })).s >= 400);
    const after = (await rows('User')).find((u) => u.id === user.id);
    assert.strictEqual(after.role, 'admin');
    assert.strictEqual((await api('GET', '/api/auth/me')).j?.role, 'admin');
  });

  await test('other fields on the operator can still be edited', async () => {
    const user = (await rows('User')).find((u) => u.email === EMAIL);
    assert.strictEqual((await api('PATCH', `/api/entities/User/${user.id}`, { full_name: 'New Name' })).s, 200);
  });

  console.log('\nCross-site requests, with no password set');

  const evil = { Origin: 'http://evil.example' };

  await test('a text/plain POST from another site cannot flatten the account', async () => {
    const res = await api('POST', '/api/functions/v6Control', JSON.stringify({ action: 'flattenAll', confirm: 'FLATTEN', reason: 'csrf', note: 'csrf' }), { ...evil, 'Content-Type': 'text/plain' });
    assert.strictEqual(res.s, 403);
    assert.strictEqual(res.h.get('access-control-allow-origin'), null);
    assert.ok(!(await rows('V6Config'))[0].halt_request);
  });

  await test('a JSON POST from another site is refused too, on every route', async () => {
    for (const [method, url, body] of [
      ['POST', '/api/functions/v6Control', { action: 'status' }], ['POST', '/api/maintenance/reset', { confirm: 'RESET' }],
      ['PATCH', '/api/entities/AutoTradingSettings/x', {}], ['DELETE', '/api/entities/Trade/x', undefined],
    ]) assert.strictEqual((await api(method, url, body, evil)).s, 403, url);
  });

  // fetch would tidy these paths and Host headers, so they go out as written.
  const raw = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body ?? '';
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers: { 'Content-Length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ s: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(payload);
  });

  await test('a rebound Host is refused on reads too, with no password set', async () => {
    const rebound = { Host: `evil.example:${PORT}` };
    for (const [method, url] of [['GET', '/api/entities/User'], ['GET', '/api/health'], ['HEAD', '/api/entities/User'], ['OPTIONS', '/api/entities/User']]) {
      const res = await raw(method, url, undefined, rebound);
      assert.strictEqual(res.s, 403, `${method} ${url}`);
      assert.ok(!res.text.includes('@'), 'no user row in the answer');
    }
    assert.strictEqual((await raw('GET', '/api/entities/User', undefined, { Host: `localhost:${PORT}` })).s, 200);
    assert.strictEqual((await raw('GET', '/api/entities/User', undefined, { Host: `127.0.0.1:${PORT}` })).s, 200);
  });

  await test('a path the router would still route cannot step around the check', async () => {
    const flatten = JSON.stringify({ action: 'pauseEntries', reason: 'csrf' });
    for (const url of ['/.//api/functions/v6Control', '/./api/functions/v6Control', '/x/..//api/functions/v6Control', '///api/functions/v6Control', '/API/functions/v6Control']) {
      const res = await raw('POST', url, flatten, { ...evil, 'Content-Type': 'text/plain' });
      assert.ok(!/"ok"\s*:\s*true/.test(res.text), url);
    }
    assert.strictEqual((await raw('POST', '/.//api/functions/v6Control', flatten, { ...evil, 'Content-Type': 'text/plain' })).s, 403);
    assert.strictEqual((await raw('GET', '/.//api/entities/User', undefined, { Host: 'evil.example' })).s, 403);
    assert.ok(!(await rows('V6Config'))[0].halt_request);
  });

  await test('positions set to text shows as damaged, then the next run restores the list', async () => {
    await cycle();
    const [row] = await rows('Portfolio');
    assert.strictEqual((await api('PATCH', `/api/entities/Portfolio/${row.id}`, { positions: 'x' })).s, 200);
    const status = await control({ action: 'status' });
    assert.strictEqual(status.s, 200);
    assert.strictEqual(status.j.positionsDamaged, true);
    assert.strictEqual(status.j.headline.state, 'NEEDS_REVIEW');
    await cycle();
    assert.ok(Array.isArray((await rows('Portfolio'))[0].positions));
    assert.strictEqual((await control({ action: 'status' })).j.positionsDamaged, false);
  });

  await test('Sec-Fetch-Site cross-site is refused even with no Origin', async () => {
    assert.strictEqual((await api('POST', '/api/functions/v6Control', { action: 'status' }, { 'Sec-Fetch-Site': 'cross-site' })).s, 403);
  });

  await test('a body that is not JSON is refused, from anywhere', async () => {
    assert.strictEqual((await api('POST', '/api/functions/v6Control', '{"action":"status"}', { 'Content-Type': 'text/plain' })).s, 415);
    assert.strictEqual((await api('POST', '/api/functions/v6Control', 'a=1', { 'Content-Type': 'application/x-www-form-urlencoded' })).s, 415);
  });

  await test('the app itself still works: its own origin, the dev server, and local tools', async () => {
    for (const origin of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, 'http://localhost:5173', 'http://127.0.0.1:5173']) {
      assert.strictEqual((await api('POST', '/api/functions/v6Control', { action: 'status' }, { Origin: origin })).s, 200, origin);
    }
    assert.strictEqual((await api('POST', '/api/functions/v6Control', { action: 'status' })).s, 200);
    assert.strictEqual((await api('POST', '/api/functions/v6Control', { action: 'status' }, { 'Content-Type': 'application/json; charset=utf-8' })).s, 200);
    assert.strictEqual((await api('GET', '/api/entities/Portfolio', undefined, evil)).s, 200, 'a read is not a state change, and CORS keeps its answer from the page');
  });

  await test('a preflight from another site is given no permission', async () => {
    const res = await fetch(`${BASE}/api/entities/Portfolio`, { method: 'OPTIONS', headers: { ...evil, 'Access-Control-Request-Method': 'PATCH' } });
    assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
  });

  console.log('\nDamaged files on a running server');

  await test('a damaged file answers 503 rather than an empty list, and the server still starts', async () => {
    await stop();
    writeFileSync(path.join(ENTITIES, 'Notification.json'), '[{"broken');
    writeFileSync(path.join(ENTITIES, 'User.json'), '[{"broken');
    await start();
    assert.strictEqual((await api('GET', '/api/entities/Notification')).s, 503);
    assert.strictEqual((await api('POST', '/api/entities/Notification', { title: 'x' })).s, 503);
    assert.ok(readFileSync(path.join(ENTITIES, 'Notification.json'), 'utf8').includes('broken'), 'never overwritten');
    assert.strictEqual(readdirSync(ENTITIES).filter((f) => f.startsWith('Notification.json.corrupt-')).length, 1, 'one salvage copy, however many reads');
  });
} finally {
  await stop();
  rmSync(path.dirname(APP), { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
