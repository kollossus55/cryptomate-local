import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';

import { createMarketHub } from './shared/v6Exchanges.js';
import { STRATEGIES } from './shared/v6Strategies.js';
import { createIntrabarReader } from './intrabar.js';
import { runCycle } from './engine.js';

// One hub per process, shared with v6Control, so backoff is global (CONTRACT section 6).
const HUB = Symbol.for('cryptomate.v6.hub');
const INTRABAR = Symbol.for('cryptomate.v6.intrabar');

function sharedHub(venues: { venue: string; enabled: boolean; priority: number }[] = []) {
  const on = venues.filter((v) => v.enabled).sort((a, b) => a.priority - b.priority).map((v) => v.venue);
  const key = on.join(',');
  const held = (globalThis as any)[HUB];
  if (held?.key === key) return held.hub;
  const hub = createMarketHub(on.length ? { enabled: on, priorities: on } : {});
  (globalThis as any)[HUB] = { key, hub };
  return hub;
}

function loadHistory() {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), 'data', 'v6', 'signal-history.json'), 'utf8'));
  } catch {
    return null; // A missing table fails the history check, so entries stay blocked.
  }
}

async function loadGate() {
  try {
    const {
      createSignalGate, verifyCertificate, initialStrategyState, advanceLifecycle,
      recordForwardTrade, recordShadowResult, returnFromShadow,
    } = await import('./shared/v6SignalGate.js');
    return {
      createSignalGate, verifyCertificate, initialStrategyState, advanceLifecycle,
      recordForwardTrade, recordShadowResult, returnFromShadow,
    };
  } catch {
    return null; // No gate module means no strategy runs. Exits still do.
  }
}

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (user?.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

  const entities = base44.asServiceRole.entities;
  try {
    // An unreadable config must not stop exits. The engine reports it and holds entries.
    const configs = await entities.V6Config.list('-created_date', 1).catch(() => []);
    const result = await runCycle({
      entities,
      hub: sharedHub(configs[0]?.venues),
      intrabar: ((globalThis as any)[INTRABAR] ??= createIntrabarReader()),
      registry: STRATEGIES,
      gateModule: await loadGate(),
      history: loadHistory(),
      now: Date.now,
    });
    return Response.json(result);
  } catch (err) {
    // Nothing committed, so the next tick starts from the last good state.
    const t = Date.now();
    await entities.V6RiskEvent.create({
      t, type: 'cycle_failed', severity: 'critical', code: 'cycle_failed', message: `Engine cycle failed: ${err.message}`,
      data: {}, sticky: true, acked_at: null, cleared_at: null,
    }).catch(() => {});
    return Response.json({ ok: false, status: 'failed', error: err.message, logLine: `failed: ${err.message}` }, { status: 500 });
  }
}
