/**
 * Deno-to-Node function runtime.
 *
 * The 16 backend functions were written for Base44's Deno runtime. Rather than
 * rewrite them — 16 files that would then drift from the hosted versions — this
 * provides the environment they expect, so they run unmodified:
 *
 *  - `Deno.serve(handler)` is captured at import time instead of starting a
 *    server. Ten of the functions register their handler this way; the other
 *    six use `export default`, and both are supported.
 *  - `Deno.env.get(k)` reads process.env.
 *  - `npm:@base44/sdk` is intercepted by a loader hook and resolved to the
 *    local shim below, which implements the entity and auth surface the
 *    functions actually call.
 *
 * TypeScript: the functions are .ts but use only type annotations, which Node
 * 22's built-in type stripping handles. No build step, no transpiler.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';

import { LOCAL_USER_EMAIL } from './entityStore.js';

const LOCAL_USER = {
  id: 'local-operator',
  email: LOCAL_USER_EMAIL,
  full_name: process.env.OPERATOR_NAME || 'Administrator',
  role: 'admin',
};

/**
 * The SDK surface the functions use.
 *
 * Deliberately the same object for `entities` and `asServiceRole.entities`:
 * Base44 used that split for row-level security across users, and there is
 * exactly one user here. Keeping both names means the function code needs no
 * edits.
 */
export function makeBase44Shim(store, { getRegistry } = {}) {
  const collection = (name) => ({
    list: async (sort, limit) => store.list(name, { sort, limit }),
    filter: async (query, sort, limit) => store.list(name, { filter: query, sort, limit }),
    get: async (id) => store.get(name, id),
    create: async (data) => store.create(name, data),
    bulkCreate: async (rows) => store.bulkCreate(name, rows),
    update: async (id, data) => store.update(name, id, data),
    updateMany: async (query, data) => store.updateMany(name, query, data),
    delete: async (id) => store.delete(name, id),
    deleteMany: async (query) => store.deleteMany(name, query),
  });

  const entities = new Proxy({}, {
    get: (target, name) => {
      if (typeof name !== 'string') return undefined;
      if (!target[name]) target[name] = collection(name);
      return target[name];
    },
  });

  /**
   * Function-to-function invocation.
   *
   * Three call sites need this: tradingScheduler invokes autoTradingWorker,
   * and both autoTradingWorker and executeApprovedTrade invoke
   * liveOrderExecution. Without it, base44.functions.invoke is undefined and
   * the scheduler fails every cycle with "Cannot read properties of undefined
   * (reading 'invoke')" — which is a bot that scans but never trades.
   *
   * The registry is passed lazily because the shim is built before any function
   * module is loaded.
   *
   * Returns the SDK's { data, status } shape, which is what the callers
   * destructure (`response?.data ?? response`, `response?.status >= 400`).
   */
  const invoke = async (name, payload = {}) => {
    const registry = getRegistry?.();
    if (!registry) {
      throw new Error('Function registry is not available yet');
    }

    // Guard against a cycle: a function invoking something that invokes it
    // back would recurse until the stack blew, with no useful error.
    invokeDepth++;
    try {
      if (invokeDepth > MAX_INVOKE_DEPTH) {
        throw new Error(
          `Function invocation nested more than ${MAX_INVOKE_DEPTH} deep (at "${name}") — ` +
          `this looks like a loop`
        );
      }

      const data = await registry.invoke(name, payload);
      return { data, status: 200 };
    } catch (err) {
      // Mirror the SDK's axios-style error so the callers' existing
      // `invokeErr.response?.status` handling works unchanged.
      const status = err.status ?? 500;
      const wrapped = new Error(err.message);
      wrapped.response = { status, data: err.body ?? { error: err.message } };
      throw wrapped;
    } finally {
      invokeDepth--;
    }
  };

  const functions = { invoke };

  /**
   * Core integrations.
   *
   * InvokeLLM was a Base44 platform service billed in credits. There is no
   * local equivalent, so this routes to YOUR OWN provider, configured in .env:
   *
   *   LLM_PROVIDER=anthropic|openai|google
   *   LLM_API_KEY=...
   *   LLM_MODEL=claude-sonnet-4-5   (optional; a sensible default per provider)
   *
   * This matters more than it looks. The AI confirmation gate in
   * autoTradingWorker FAILS CLOSED: when ai_confirmation_mode is 'auto' and the
   * LLM call throws, every trade is rejected. So an unconfigured provider plus
   * that setting equals a bot that scans busily and never trades — with only
   * one log line to say why. Hence the loud error here and the startup warning
   * in index.js.
   */
  const integrations = {
    Core: {
      InvokeLLM: async ({ prompt, response_json_schema, model, add_context_from_internet } = {}) => {
        // add_context_from_internet was a Base44 platform feature (hosted web
        // browsing). There is no local equivalent, and previously it was
        // silently dropped — which turned "base every number on live web
        // search" system prompts into unqualified model guesswork. A function
        // that needs live search should not get hallucinated sentiment
        // labelled as sourced-from-web, so this is at least named rather than
        // swallowed. No local web-search source exists to feed it.
        if (add_context_from_internet) {
          console.warn('InvokeLLM: add_context_from_internet is not supported locally — the model will only see the prompt.');
        }

        const provider = process.env.LLM_PROVIDER;
        const apiKey = process.env.LLM_API_KEY;

        if (!provider || !apiKey) {
          throw new Error(
            'No LLM provider configured. Base44 supplied this as a hosted service; ' +
            'locally it needs your own key. Set LLM_PROVIDER and LLM_API_KEY in .env, ' +
            "or set AI confirmation to 'off' in Auto-Trading settings."
          );
        }

        const defaults = {
          anthropic: 'claude-sonnet-4-5',
          openai: 'gpt-4o-mini',
          google: 'gemini-2.0-flash',
        };

        // LOCAL FIX: Base44-billing-era model names. aiMarketIntelligence and
        // aiTradingRecommendations still pass model: 'gemini_3_flash', which
        // is not a real Google generateContent model ID — the Google API 404s
        // it and every call from those functions failed. Map stale platform
        // aliases back to the provider's sensible default instead of failing.
        const STALE_ALIASES = new Set(['gemini_3_flash']);

        const requested = model || process.env.LLM_MODEL || defaults[provider];
        const modelName = STALE_ALIASES.has(requested)
          ? (process.env.LLM_MODEL || defaults[provider])
          : requested;
        if (!modelName) {
          throw new Error(`No model for LLM_PROVIDER="${provider}". Set LLM_MODEL in .env.`);
        }

        // Reuse the app's own provider client rather than a second
        // implementation that could drift from it.
        const { callCustomLLM } = await import('../base44/shared/customLLM.ts');
        return callCustomLLM({ provider, modelName, apiKey }, prompt, response_json_schema);
      },

      // File uploads are not implemented locally; nothing in the trading path
      // uses them, and failing clearly beats returning a broken URL.
      UploadPublicFile: async () => { throw new Error('File upload is not available in the local build'); },
      UploadPrivateFile: async () => { throw new Error('File upload is not available in the local build'); },
      CreateFileSignedUrl: async ({ file_uri }) => ({ signed_url: file_uri }),
    },
  };

  const client = {
    entities,
    functions,
    integrations,
    asServiceRole: { entities, functions, integrations },
    auth: {
      me: async () => LOCAL_USER,
      isAuthenticated: async () => true,
    },
  };

  return client;
}

// Shared across the single shim instance in this process.
let invokeDepth = 0;
const MAX_INVOKE_DEPTH = 5;

/**
 * Install the Deno globals the functions expect.
 *
 * Called once before any function module is imported. `Deno.serve` records the
 * handler rather than binding a port — the local server dispatches to it.
 */
let capturedHandler = null;

export function installDenoShim() {
  if (globalThis.Deno) return;

  globalThis.Deno = {
    serve: (handlerOrOptions, maybeHandler) => {
      capturedHandler = typeof handlerOrOptions === 'function' ? handlerOrOptions : maybeHandler;
      // Base44's runtime returns a server object; nothing calls into it, but
      // returning a shape rather than undefined avoids surprises.
      return { finished: Promise.resolve(), shutdown: async () => {} };
    },
    env: {
      get: (key) => process.env[key],
      set: (key, value) => { process.env[key] = value; },
      has: (key) => key in process.env,
      toObject: () => ({ ...process.env }),
    },
    exit: (code = 0) => process.exit(code),
  };
}

/**
 * Load every function once and index its handler by name.
 */
export class FunctionRegistry {
  constructor({ functionsDir, store, log }) {
    this.dir = functionsDir;
    this.store = store;
    this.log = log;
    this.handlers = new Map();
    this.libraries = new Set();
    this.loadErrors = new Map();
  }

  async loadAll() {
    installDenoShim();

    if (!existsSync(this.dir)) {
      throw new Error(`Functions directory not found: ${this.dir}`);
    }

    const names = readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const name of names) {
      const entry = path.join(this.dir, name, 'entry.ts');
      if (!existsSync(entry)) continue;

      try {
        capturedHandler = null;
        const mod = await import(pathToFileURL(entry).href);

        // Deno.serve registers during import; export default is on the module.
        const handler = capturedHandler || mod.default;

        if (typeof handler !== 'function') {
          // Not every directory is an HTTP endpoint — some are shared helper
          // modules the other functions import (autoTradingEngineBackend is
          // one). Importing cleanly with no handler is success, not failure.
          this.libraries.add(name);
          continue;
        }

        this.handlers.set(name, handler);
      } catch (err) {
        // One broken function must not stop the other fifteen from loading.
        this.loadErrors.set(name, err.message);
        this.log?.warn(`Function "${name}" failed to load: ${err.message}`);
      }
    }

    capturedHandler = null;
    this.log?.info(`Loaded ${this.handlers.size} backend functions` +
      (this.libraries.size ? `, ${this.libraries.size} shared module(s)` : '') +
      (this.loadErrors.size ? ` — ${this.loadErrors.size} FAILED` : ''));

    return { loaded: [...this.handlers.keys()], failed: [...this.loadErrors.entries()] };
  }

  has(name) {
    return this.handlers.has(name);
  }

  /**
   * Invoke a function with a Request built to look like Base44's.
   *
   * The functions call createClientFromRequest(req), which the loader hook
   * resolves to the shim. The request carries no credentials because there is
   * nothing to authenticate against locally.
   */
  async invoke(name, payload) {
    const handler = this.handlers.get(name);
    if (!handler) {
      const reason = this.loadErrors.get(name);
      throw Object.assign(
        new Error(reason ? `Function "${name}" failed to load: ${reason}` : `Unknown function: ${name}`),
        { status: reason ? 500 : 404 }
      );
    }

    const request = new Request(`http://localhost/functions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });

    let response;
    try {
      response = await handler(request);
    } catch (err) {
      // A function that throws before returning a Response produces a bare
      // message with no origin, which is nearly undiagnosable once it has been
      // relayed through a caller's catch block. Log the stack here, at the
      // point it happened.
      this.log?.error(`Function "${name}" threw: ${err.message}`);
      this.log?.error(`  at ${(err.stack || '').split('\n').slice(1, 5).join('\n  at ').trim()}`);
      throw Object.assign(new Error(err.message), { status: 500, body: { error: err.message } });
    }

    if (!(response instanceof Response)) {
      // A function that returns a plain object rather than a Response.
      return response;
    }

    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }

    if (!response.ok) {
      const message = (body && body.error) || `Function "${name}" failed (${response.status})`;
      throw Object.assign(new Error(message), { status: response.status, body });
    }
    return body;
  }
}
