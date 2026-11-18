import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';

import { createMarketHub } from './shared/v6Exchanges.js';
import { STRATEGIES } from './shared/v6Strategies.js';
import { handle } from './control.js';

// The same hub the engine uses, so backoff is shared across the process.
const HUB = Symbol.for('cryptomate.v6.hub');

function sharedHub() {
  const held = (globalThis as any)[HUB];
  if (held) return held.hub;
  const hub = createMarketHub({});
  (globalThis as any)[HUB] = { key: '', hub };
  return hub;
}

async function loadGate() {
  try {
    const { verifyCertificate, strategyHash, evaluateDrift } = await import('./shared/v6SignalGate.js');
    return { verifyCertificate, strategyHash, evaluateDrift };
  } catch {
    return null;
  }
}

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user || user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const result = await handle({
    entities: base44.asServiceRole.entities, body, user, hub: sharedHub(), registry: STRATEGIES, gateModule: await loadGate(),
  });
  return Response.json(result);
}
