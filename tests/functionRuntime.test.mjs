/**
 * Function runtime tests — the SDK shim surface the backend functions rely on.
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EntityStore } from '../server/entityStore.js';
import { makeBase44Shim } from '../server/functionRuntime.js';

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

const fresh = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-fr-'));
  return { dir, store: new EntityStore(dir) };
};

console.log('\nSDK shim surface');

await test('provides every namespace the functions call', () => {
  const { dir, store } = fresh();
  const client = makeBase44Shim(store, { getRegistry: () => null });

  assert.ok(client.entities, 'entities missing');
  assert.ok(client.functions, 'functions missing');
  assert.strictEqual(typeof client.functions.invoke, 'function', 'functions.invoke missing');
  assert.ok(client.asServiceRole?.entities, 'asServiceRole.entities missing');
  assert.ok(client.asServiceRole?.functions, 'asServiceRole.functions missing');
  assert.strictEqual(typeof client.asServiceRole.functions.invoke, 'function',
    'asServiceRole.functions.invoke missing — this is what broke the scheduler');
  assert.strictEqual(typeof client.auth.me, 'function');
  rmSync(dir, { recursive: true, force: true });
});

await test('entity methods read and write through the store', async () => {
  const { dir, store } = fresh();
  const client = makeBase44Shim(store, { getRegistry: () => null });

  await client.entities.Portfolio.create({ available_balance: 500 });
  const rows = await client.entities.Portfolio.list();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].available_balance, 500);
  rmSync(dir, { recursive: true, force: true });
});

await test('invoke returns the SDK { data, status } shape', async () => {
  const { dir, store } = fresh();
  const registry = { invoke: async (name, payload) => ({ ok: true, name, got: payload }) };
  const client = makeBase44Shim(store, { getRegistry: () => registry });

  const response = await client.functions.invoke('someFunction', { a: 1 });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.ok, true);
  assert.strictEqual(response.data.name, 'someFunction');
  assert.deepStrictEqual(response.data.got, { a: 1 });
  rmSync(dir, { recursive: true, force: true });
});

await test('asServiceRole.functions.invoke works the same way', async () => {
  const { dir, store } = fresh();
  const registry = { invoke: async () => ({ ok: true }) };
  const client = makeBase44Shim(store, { getRegistry: () => registry });

  const response = await client.asServiceRole.functions.invoke('liveOrderExecution', {});
  assert.strictEqual(response.data.ok, true);
  rmSync(dir, { recursive: true, force: true });
});

await test('a failing function throws an axios-shaped error', async () => {
  const { dir, store } = fresh();
  const registry = {
    invoke: async () => {
      throw Object.assign(new Error('boom'), { status: 400, body: { error: 'bad input' } });
    },
  };
  const client = makeBase44Shim(store, { getRegistry: () => registry });

  // The callers read invokeErr.response?.status and .response?.data, so the
  // shim must present failures that way rather than as a bare Error.
  await assert.rejects(
    () => client.functions.invoke('whatever'),
    (err) => {
      assert.strictEqual(err.response.status, 400);
      assert.deepStrictEqual(err.response.data, { error: 'bad input' });
      return true;
    }
  );
  rmSync(dir, { recursive: true, force: true });
});

await test('an unexpected throw still carries status 500', async () => {
  const { dir, store } = fresh();
  const registry = { invoke: async () => { throw new Error('kaboom'); } };
  const client = makeBase44Shim(store, { getRegistry: () => registry });

  await assert.rejects(
    () => client.functions.invoke('whatever'),
    (err) => {
      assert.strictEqual(err.response.status, 500);
      assert.match(err.message, /kaboom/);
      return true;
    }
  );
  rmSync(dir, { recursive: true, force: true });
});

await test('a missing registry fails with a clear message, not undefined', async () => {
  const { dir, store } = fresh();
  const client = makeBase44Shim(store, { getRegistry: () => null });
  await assert.rejects(() => client.functions.invoke('x'), /registry is not available/);
  rmSync(dir, { recursive: true, force: true });
});

await test('runaway nesting is stopped rather than blowing the stack', async () => {
  const { dir, store } = fresh();
  let client;
  // A function that invokes itself forever.
  const registry = { invoke: async (name) => client.functions.invoke(name) };
  client = makeBase44Shim(store, { getRegistry: () => registry });

  await assert.rejects(() => client.functions.invoke('loops'), /looks like a loop/);
  rmSync(dir, { recursive: true, force: true });
});

await test('depth counter resets, so normal calls still work after a loop is caught', async () => {
  const { dir, store } = fresh();
  let client;
  const registry = {
    invoke: async (name) => (name === 'loops' ? client.functions.invoke(name) : { fine: true }),
  };
  client = makeBase44Shim(store, { getRegistry: () => registry });

  await assert.rejects(() => client.functions.invoke('loops'));
  const after = await client.functions.invoke('normal');
  assert.strictEqual(after.data.fine, true, 'depth counter leaked after a caught loop');
  rmSync(dir, { recursive: true, force: true });
});

console.log(`\n${'-'.repeat(52)}\n${passed} passed, ${failed} failed\n${'-'.repeat(52)}\n`);
process.exit(failed > 0 ? 1 : 0);
