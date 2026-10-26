import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { OKX_URL, decrypt, buildOkxHeaders } from '../../shared/okxExchange.ts';
import {
  KRAKEN_URL,
  buildKrakenBody,
  buildKrakenHeaders,
  isKrakenLockedOut,
  getKrakenLockoutRemainingMs,
  recordKrakenLockout,
  isKrakenLockoutError,
} from '../../shared/krakenExchange.ts';

/**
 * liveOrderExecution — places real orders using stored, encrypted credentials,
 * then reconciles the fill state and persists it on the Trade entity.
 *
 * SAFETY (non-negotiable):
 *  - is_testnet is read from the stored ExchangeConnection record, NEVER from
 *    the request body. A client cannot flip demo → live.
 *  - OKX Phase 1 guard: refuses live (is_testnet=false) OKX connections. Only
 *    OKX demo trading is allowed until Phase 2 is explicitly enabled.
 *  - Kraken has NO testnet. All Kraken orders are live. The function requires
 *    an explicit confirm_live=true flag to place a Kraken order. A dry_run
 *    mode tests credentials via the read-only Balance endpoint without placing.
 *  - Kill switch: if AutoTradingSettings.kill_switch_enabled is true, the
 *    function refuses regardless of who calls it or where the call originates.
 *  - Ownership: the connection must belong to the calling user.
 *  - LOCAL FIX: instrument rules (min size, lot increment, price tick) are
 *    fetched from the exchange ONCE per execution run and enforced on every
 *    order. If the rules cannot be fetched, the order FAILS — an unrounded
 *    quantity is never sent, because exchanges either reject it or silently
 *    truncate it, and neither failure mode is safe for live money.
 *  - LOCAL FIX: dry_run is honored on BOTH paths. On OKX it validates
 *    credentials through a read-only endpoint and returns what WOULD have
 *    been sent, labelled simulated — it never touches the order endpoint.
 *
 * MAPPING (internal → OKX):
 *   asset_symbol "BTC/USDT" → instId "BTC-USDT"
 *   side "buy"/"sell"       → OKX side "buy"/"sell"
 *   order_type "market"    → ordType "market"
 *   order_type "limit"     → ordType "limit" (+ px)
 *   tdMode "cash" (spot)
 *   sz = quantity, rounded DOWN to the instrument's lotSz (string)
 *
 * MAPPING (internal → Kraken):
 *   asset_symbol "BTC/USD" → pair "BTC/USD" (Kraken's own pair format)
 *   side "buy"/"sell"      → type "buy"/"sell"
 *   order_type "market"    → ordertype "market"
 *   order_type "limit"     → ordertype "limit" (+ price)
 *   volume = quantity, rounded DOWN to the pair's lot_decimals (string)
 */

// ---------------------------------------------------------------------------
// LOCAL FIX: instrument precision + defensive response handling helpers.
// Everything below exists because the live path used to send raw float
// quantities and could be silently broken by exchange formatting rules.
// ---------------------------------------------------------------------------

/** Instrument sizing/precision rules for one market. */
interface InstrumentRules {
  /** Minimum order size in the base currency (OKX minSz / Kraken ordermin). */
  minSize: number;
  /** Size increment in the base currency (OKX lotSz / 10^-Kraken lot_decimals). */
  increment: number;
  /** Decimal places allowed on the size string. */
  sizeDecimals: number;
  /** Price tick (OKX tickSz / 10^-Kraken pair_decimals). */
  priceIncrement: number;
  /** Decimal places allowed on the price string. */
  priceDecimals: number;
}

/** A rules lookup either yields rules or a human-readable reason to refuse. */
type RulesResult = { ok: true; rules: InstrumentRules } | { ok: false; reason: string };

/** What fetchExchangeJson resolves to — it NEVER throws or rejects. */
interface ExchangeJsonResult {
  status: number;
  data: any;
  /** True when the body was not JSON (HTML error page, empty body, …). */
  parseFailed: boolean;
  /** Set only when the request itself failed before a response arrived. */
  transportError?: string;
}

/**
 * Decimal places of an exchange-supplied size/price STRING. OKX sends rules
 * like lotSz: "0.0001", so counting places on the raw string avoids
 * scientific-notation surprises (String(1e-8) === "1e-8").
 */
function decimalPlacesOfString(raw: string): number {
  const s = String(raw).trim();
  const e = s.search(/[eE]/);
  if (e !== -1) {
    // e.g. "1.5e-8" → 1 mantissa decimal + 8 exponent places = 9.
    const exp = parseInt(s.slice(e + 1), 10);
    const mantissa = s.slice(0, e);
    const mantissaDecimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
    return Math.max(0, mantissaDecimals - exp);
  }
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/**
 * Round value DOWN to a whole multiple of `increment` and return it as an
 * exact decimal string with `decimals` places — never a drifting float like
 * 0.30000000000000004. Rounding down (never up) so the order can never
 * exceed the caller's intended notional; the residual dust simply stays put.
 */
function roundDownToIncrement(value: number, increment: number, decimals: number): string {
  const scaled = value / increment;
  let steps = Math.floor(scaled);
  // A value that is an exact multiple can land a hair BELOW the step
  // boundary in floating point (0.3/0.1 → 2.9999999999999996). Snap to the
  // next step when we are epsilon-close, so a whole increment of size is
  // not lost, while a genuinely sub-multiple value still rounds down.
  if (scaled - steps > 1 - 1e-9) steps += 1;
  if (steps < 0) steps = 0;
  return (steps * increment).toFixed(decimals);
}

/**
 * Round a price to the instrument tick, biased by direction. For buys round
 * DOWN (never agree to pay more than requested); for sells round UP (never
 * agree to receive less than requested). A sell that sits a half-tick above
 * the intended price is merely less likely to fill — it can never execute at
 * a worse price than the caller asked for. The 1e-6-step epsilon is still
 * far below the half-tick spacing of any genuinely distinct price, so it
 * only glues float drift back onto the correct tick, never a real price.
 */
function roundPriceToTick(
  price: number, tick: number, decimals: number, side: 'buy' | 'sell'
): string {
  const scaled = price / tick;
  const steps = side === 'buy'
    ? Math.floor(scaled + 1e-6)
    : Math.ceil(scaled - 1e-6);
  const safe = Math.max(0, steps);
  return (safe * tick).toFixed(decimals);
}

/**
 * LOCAL FIX: clamp any exchange-provided error text to 200 chars before it is
 * returned to the caller or written to the logs. Exchange error bodies can
 * echo signed query strings or credential metadata, so raw bodies are never
 * embedded verbatim anywhere.
 */
function clampErrorText(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (value === null || value === undefined) text = '';
  else {
    try { text = JSON.stringify(value) ?? String(value); }
    catch { text = String(value); }
  }
  text = text.replace(/\s+/g, ' ').trim() || 'Unknown error';
  return text.length > 200 ? `${text.slice(0, 200)}…[truncated]` : text;
}

/**
 * LOCAL FIX: every exchange call goes through this wrapper. Previously a
 * transport failure or a non-JSON body (HTML error page, empty response)
 * threw out of the order path — potentially AFTER an order existed at the
 * exchange — and hit the outer catch, returning a generic 500 while the
 * order was live. Failure is now returned as data, so every call site can
 * produce a structured, honest error. Error text is always clamped.
 */
async function fetchExchangeJson(url: string, init?: RequestInit): Promise<ExchangeJsonResult> {
  try {
    const res = await fetch(url, init);
    let data: any = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data, parseFailed: data === null };
  } catch (e) {
    return {
      status: 0,
      data: null,
      parseFailed: true,
      transportError: e instanceof Error ? e.message : 'unknown transport error',
    };
  }
}

/**
 * LOCAL FIX: once an order exists at the exchange, bookkeeping failures must
 * not turn the response into an error — the caller would conclude nothing
 * was placed while a live order exists. Updates are logged and swallowed.
 */
async function tryTradeUpdate(
  base44: any, tradeId: string | null, patch: Record<string, unknown>, context: string
): Promise<void> {
  if (!tradeId) return;
  try {
    await base44.asServiceRole.entities.Trade.update(tradeId, patch);
  } catch (e) {
    console.error(`liveOrderExecution: ${context} update failed for trade ${tradeId}: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}

/**
 * LOCAL FIX: fetch OKX instrument rules (public endpoint, no auth) for one
 * instId. The caller passes an invocation-scoped Map, so an execution run
 * fetches each instrument at most once. Any failure returns a refusal
 * reason — the order path fails outright rather than sending an unrounded
 * order and hoping the exchange's truncation matches our intent.
 */
async function fetchOkxInstrumentRules(
  instId: string, cache: Map<string, RulesResult>
): Promise<RulesResult> {
  const cached = cache.get(instId);
  if (cached) return cached;

  const result = await (async (): Promise<RulesResult> => {
    const res = await fetchExchangeJson(
      `${OKX_URL}/api/v5/public/instruments?instType=SPOT&instId=${encodeURIComponent(instId)}`
    );
    if (res.parseFailed || !res.data) {
      return {
        ok: false,
        reason: `OKX instrument rules could not be read (HTTP ${res.status}${res.transportError ? `: ${clampErrorText(res.transportError)}` : ''}) — refusing to send an unrounded order.`,
      };
    }
    if (res.data.code !== '0') {
      return {
        ok: false,
        reason: `OKX instrument rules request failed: ${clampErrorText(res.data.msg)}`,
      };
    }
    const inst: any = Array.isArray(res.data.data)
      ? res.data.data.find((i: any) => i && i.instId === instId)
      : null;
    if (!inst) {
      return {
        ok: false,
        reason: `OKX has no SPOT instrument rules for ${instId} — refusing to send an unrounded order.`,
      };
    }
    const lotSz = parseFloat(inst.lotSz);
    const minSz = parseFloat(inst.minSz);
    const tickSz = parseFloat(inst.tickSz);
    if (![lotSz, minSz, tickSz].every((n) => Number.isFinite(n) && n > 0)) {
      return {
        ok: false,
        reason: `OKX returned unusable size/price rules for ${instId} (${clampErrorText(inst.lotSz)}, ${clampErrorText(inst.minSz)}, ${clampErrorText(inst.tickSz)}) — refusing to send an unrounded order.`,
      };
    }
    return {
      ok: true,
      rules: {
        minSize: minSz,
        increment: lotSz,
        sizeDecimals: decimalPlacesOfString(String(inst.lotSz)),
        priceIncrement: tickSz,
        priceDecimals: decimalPlacesOfString(String(inst.tickSz)),
      },
    };
  })();

  cache.set(instId, result);
  return result;
}

/**
 * LOCAL FIX: fetch Kraken pair rules from the public AssetPairs endpoint
 * (no auth) for one pair. Kraken normalizes pair names (BTC/USD → XBTUSD),
 * so the result key is unpredictable — accept exactly one returned pair,
 * anything else is ambiguous and refused. No rules → no order.
 */
async function fetchKrakenPairRules(
  pair: string, cache: Map<string, RulesResult>
): Promise<RulesResult> {
  const cached = cache.get(pair);
  if (cached) return cached;

  const result = await (async (): Promise<RulesResult> => {
    const res = await fetchExchangeJson(
      `${KRAKEN_URL}/0/public/AssetPairs?pair=${encodeURIComponent(pair)}`
    );
    if (res.parseFailed || !res.data) {
      return {
        ok: false,
        reason: `Kraken pair rules could not be read (HTTP ${res.status}${res.transportError ? `: ${clampErrorText(res.transportError)}` : ''}) — refusing to send an unrounded order.`,
      };
    }
    if (Array.isArray(res.data.error) && res.data.error.length > 0) {
      return {
        ok: false,
        reason: `Kraken pair rules request failed: ${clampErrorText(res.data.error)}`,
      };
    }
    const entries: any[] = res.data.result ? Object.values(res.data.result) : [];
    if (entries.length !== 1 || !entries[0]) {
      return {
        ok: false,
        reason: `Kraken pair rules for ${pair} were ambiguous (${entries.length} matches) — refusing to send an unrounded order.`,
      };
    }
    const pairInfo = entries[0];
    const lotDecimals = pairInfo.lot_decimals;
    const pairDecimals = pairInfo.pair_decimals;
    const orderMin = parseFloat(pairInfo.ordermin);
    if (
      !Number.isInteger(lotDecimals) || lotDecimals < 0 || lotDecimals > 18 ||
      !Number.isInteger(pairDecimals) || pairDecimals < 0 || pairDecimals > 18 ||
      !Number.isFinite(orderMin) || orderMin <= 0
    ) {
      return {
        ok: false,
        reason: `Kraken returned unusable size/price rules for ${pair} (${clampErrorText(pairInfo.ordermin)}, lot_decimals ${clampErrorText(pairInfo.lot_decimals)}, pair_decimals ${clampErrorText(pairInfo.pair_decimals)}) — refusing to send an unrounded order.`,
      };
    }
    return {
      ok: true,
      rules: {
        minSize: orderMin,
        increment: Math.pow(10, -lotDecimals),
        sizeDecimals: lotDecimals,
        priceIncrement: Math.pow(10, -pairDecimals),
        priceDecimals: pairDecimals,
      },
    };
  })();

  cache.set(pair, result);
  return result;
}

/**
 * LOCAL FIX: shared guards that turn a raw quantity/price into the validated,
 * exchange-legal strings both order paths send. Returns a refusal (with a
 * human-readable reason) instead of silently shipping a bad size.
 */
function enforceOrderSize(
  quantity: number, rules: InstrumentRules, minLabel: string, baseCcy: string
): { ok: true; sz: string; value: number } | { ok: false; error: string } {
  if (quantity < rules.minSize) {
    return {
      ok: false,
      error: `Order size ${quantity} ${baseCcy} is below the ${minLabel} minimum of ${rules.minSize} ${baseCcy}. Nothing was sent.`,
    };
  }
  const sz = roundDownToIncrement(quantity, rules.increment, rules.sizeDecimals);
  const value = parseFloat(sz);
  if (!(value > 0) || value < rules.minSize) {
    return {
      ok: false,
      error: `Order size ${quantity} ${baseCcy} rounds down to ${sz}, which is below the ${minLabel} minimum of ${rules.minSize}. Nothing was sent.`,
    };
  }
  return { ok: true, sz, value };
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user?.email) {
      return Response.json({ success: false, error: 'Not authenticated' }, { status: 401 });
    }

    const body = await req.json();
    const { connection_id, asset_symbol, side, order_type, quantity, price, dry_run, confirm_live, user_email: callerEmail } = body;

    // When called from the auto-trading worker (service role), callerEmail is
    // the owning user's email. When called directly from the frontend, use
    // the authenticated user's own email. Only the service role (admin) may
    // act on behalf of another user.
    const actingEmail = (callerEmail && user.role === 'admin') ? callerEmail : user.email;

    // --- Validate input ---
    if (!connection_id || !asset_symbol || !side || !order_type || !quantity) {
      return Response.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    }
    if (side !== 'buy' && side !== 'sell') {
      return Response.json({ success: false, error: 'side must be buy or sell' }, { status: 400 });
    }
    if (order_type !== 'market' && order_type !== 'limit') {
      return Response.json({ success: false, error: 'order_type must be market or limit' }, { status: 400 });
    }
    // LOCAL FIX: numeric validation instead of truthiness — the old `!price`/
    // `!quantity` checks rejected only falsy values, and a non-numeric
    // quantity/price leaked straight into the signed exchange payload.
    if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
      return Response.json({ success: false, error: 'quantity must be a positive number' }, { status: 400 });
    }
    if (order_type === 'limit' && (!Number.isFinite(Number(price)) || Number(price) <= 0)) {
      return Response.json({ success: false, error: 'limit orders require a positive price' }, { status: 400 });
    }

    // --- Load connection (ownership check — never trust the id alone) ---
    // asServiceRole bypasses RLS, so we fetch by id and enforce ownership in
    // code. The old filter used a custom `created_by` email field that was
    // never declared in the entity schema and was silently stripped on create,
    // so every lookup returned "Connection not found". We use the built-in
    // created_by_id and allow admin callers (consistent with the admin RLS
    // read rule; the worker runs as admin and passes the owner's connection_id).
    const connections = await base44.asServiceRole.entities.ExchangeConnection.filter({
      id: connection_id,
    });
    const connection = connections?.[0];
    if (!connection) {
      return Response.json({ success: false, error: 'Connection not found' }, { status: 404 });
    }
    if (connection.created_by_id !== user.id && user.role !== 'admin') {
      return Response.json({ success: false, error: 'Connection not found' }, { status: 404 });
    }
    if (connection.exchange_name !== 'okx' && connection.exchange_name !== 'kraken') {
      return Response.json({ success: false, error: 'Only OKX and Kraken are supported' }, { status: 400 });
    }

    // --- Phase 1 guard: OKX testnet only. Live is blocked until Phase 2. ---
    if (connection.exchange_name === 'okx' && !connection.is_testnet) {
      return Response.json({
        success: false,
        error: 'Live trading is not yet enabled. Phase 1 is testnet (demo) only.',
      }, { status: 403 });
    }

    // --- Kill switch — hard block regardless of caller ---
    // Link settings to this connection via exchange_connection_id. The old
    // filter used a custom `created_by` email field that was never stored, so
    // it always missed and the kill switch was silently bypassed.
    const settingsList = await base44.asServiceRole.entities.AutoTradingSettings.filter({
      exchange_connection_id: connection_id,
    });
    const settings = settingsList?.[0];
    if (settings?.kill_switch_enabled) {
      return Response.json({
        success: false,
        error: 'Kill switch is active. All trading is halted.',
      }, { status: 403 });
    }

    // --- Decrypt credentials ---
    const apiKey = await decrypt(connection.encrypted_api_key);
    const apiSecret = await decrypt(connection.encrypted_api_secret);
    const apiPassphrase = connection.encrypted_api_passphrase
      ? await decrypt(connection.encrypted_api_passphrase)
      : '';

    // --- Dispatch by exchange ---
    // LOCAL FIX: actingEmail is now passed into the helpers. It was previously
    // referenced there but defined only in this scope, so any order that
    // reached Trade.create threw a ReferenceError and the caller got a
    // generic 500 while the order already existed at the exchange.
    if (connection.exchange_name === 'kraken') {
      return await executeKrakenOrder(base44, {
        apiKey, apiSecret, asset_symbol, side, order_type, quantity, price, dry_run, confirm_live, actingEmail,
      });
    }

    return await executeOkxOrder(base44, {
      apiKey, apiSecret, apiPassphrase, asset_symbol, side, order_type, quantity, price, isTestnet: connection.is_testnet, dry_run, actingEmail,
    });
  } catch (error) {
    console.error('liveOrderExecution error:', error);
    // Never echo the error body verbatim — it can contain signed query strings
    // or credential material an attacker should not see.
    return Response.json({ success: false, error: 'Order execution failed' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// OKX order path (Phase 1: testnet only)
// ---------------------------------------------------------------------------

async function executeOkxOrder(base44: any, params: any): Promise<Response> {
  const {
    apiKey, apiSecret, apiPassphrase, asset_symbol, side, order_type,
    quantity, price, isTestnet, dry_run, actingEmail,
  } = params;

  const instId = asset_symbol.replace('/', '-'); // "BTC/USDT" → "BTC-USDT"
  const baseCcy = asset_symbol.split('/')[0] || 'base currency';

  // LOCAL FIX: instrument rules are fetched ONCE per execution run and cached
  // in this invocation-scoped Map. No rules → no order: an unrounded
  // quantity is either rejected by OKX or silently truncated, and neither
  // mode is safe to discover with live money.
  const rulesCache = new Map<string, RulesResult>();
  const rulesResult = await fetchOkxInstrumentRules(instId, rulesCache);
  if (!rulesResult.ok) {
    return Response.json({ success: false, error: rulesResult.reason }, { status: 400 });
  }
  const rules = rulesResult.rules;

  // LOCAL FIX: round the size DOWN to the lot increment and enforce the
  // exchange minimum BEFORE anything is signed or sent.
  const sizeCheck = enforceOrderSize(Number(quantity), rules, 'OKX (minSz)', baseCcy);
  if (!sizeCheck.ok) {
    return Response.json({ success: false, error: sizeCheck.error }, { status: 400 });
  }
  const sz = sizeCheck.sz;

  // LOCAL FIX: limit prices are rounded to the instrument tick with a
  // direction bias (buy rounds down, sell rounds up) so the order can never
  // execute at a worse price than requested. Previously px was sent as the
  // raw float string.
  let px: string | null = null;
  if (order_type === 'limit') {
    px = roundPriceToTick(Number(price), rules.priceIncrement, rules.priceDecimals, side);
    if (!(parseFloat(px) > 0)) {
      return Response.json({ success: false, error: `Limit price ${price} rounds down to zero at OKX tick ${rules.priceIncrement}. Nothing was sent.` }, { status: 400 });
    }
  }

  // --- LOCAL FIX: dry_run was ignored on this path — a dry_run request
  // placed a real (testnet) order. It now follows the Kraken dry_run shape:
  // validate credentials through a READ-ONLY endpoint (account balance, not
  // the order endpoint) and return what WOULD have been sent, clearly
  // labelled simulated.
  if (dry_run) {
    const rulesAndSz = { instId, sz, px, rules };
    const checkPath = '/api/v5/account/balance';
    const checkHeaders = await buildOkxHeaders(
      apiKey, apiSecret, apiPassphrase, 'GET', checkPath, '', isTestnet
    );
    const check = await fetchExchangeJson(`${OKX_URL}${checkPath}`, { headers: checkHeaders });
    if (check.parseFailed || !check.data) {
      return Response.json({
        success: false,
        error: `OKX credential check failed: ${check.transportError ? clampErrorText(check.transportError) : `unreadable response (HTTP ${check.status})`}`,
      }, { status: 400 });
    }
    if (check.data.code !== '0') {
      // Clamped, never the raw body — error bodies can echo credential data.
      return Response.json({
        success: false,
        error: `OKX credential test failed: ${clampErrorText(check.data.msg)}`,
      }, { status: 400 });
    }
    return Response.json({
      success: true,
      dry_run: true,
      simulated: true,
      message: 'Credentials valid — no order was placed.',
      would_send: {
        exchange: 'okx',
        instId: rulesAndSz.instId,
        tdMode: 'cash',
        side,
        ordType: order_type,
        sz: rulesAndSz.sz,
        ...(rulesAndSz.px ? { px: rulesAndSz.px } : {}),
      },
      quantity_raw: Number(quantity),
      quantity_rounded: sizeCheck.value,
      rules: {
        minSz: rulesAndSz.rules.minSize,
        lotSz: rulesAndSz.rules.increment,
        tickSz: rulesAndSz.rules.priceIncrement,
      },
      is_testnet: isTestnet,
    });
  }

  const orderBody = JSON.stringify({
    instId,
    tdMode: 'cash',
    side,
    ordType: order_type,
    sz, // LOCAL FIX: rounded to the instrument lot increment, not the raw float
    ...(order_type === 'limit' ? { px } : {}),
  });

  const requestPath = '/api/v5/trade/order';
  const headers = await buildOkxHeaders(
    apiKey, apiSecret, apiPassphrase, 'POST', requestPath, orderBody, isTestnet
  );

  // LOCAL FIX: transport/parse failures are structured refusals, not throws.
  // If the response is unreadable the order state is genuinely unknown, and
  // the caller is told so instead of receiving a generic 500.
  const res = await fetchExchangeJson(`${OKX_URL}${requestPath}`, { method: 'POST', headers, body: orderBody });
  if (res.parseFailed || !res.data) {
    return Response.json({
      success: false,
      error: `OKX order response was unreadable (HTTP ${res.status}${res.transportError ? `: ${clampErrorText(res.transportError)}` : ''}) — the order state at OKX is unknown. Check Open Orders before retrying.`,
    }, { status: 502 });
  }

  if (res.data.code !== '0') {
    return Response.json({
      success: false,
      error: `OKX rejected the order (${clampErrorText(res.data.code)}): ${clampErrorText(res.data.msg)}`,
    }, { status: 400 });
  }

  const ordId = res.data.data?.[0]?.ordId;
  if (!ordId) {
    return Response.json({ success: false, error: 'OKX accepted but returned no order ID' }, { status: 500 });
  }

  // LOCAL FIX: the order is already live at this point, so a persistence
  // failure must NOT be reported as a total failure. The Trade record is
  // best-effort; the response still says the order exists.
  let tradeId: string | null = null;
  try {
    const trade = await base44.asServiceRole.entities.Trade.create({
      asset_symbol, trade_type: side, quantity: sizeCheck.value,
      price: px ? parseFloat(px) : 0,
      total_value: px ? parseFloat(px) * sizeCheck.value : 0,
      exchange: 'okx', status: 'pending', owner_email: actingEmail,
    });
    tradeId = trade?.id ?? null;
  } catch (e) {
    console.error(`liveOrderExecution: OKX order ${String(ordId)} placed but the Trade record could not be created: ${e instanceof Error ? e.message : 'unknown error'}`);
  }

  let fill: { state: string; avgPx: string | null; fillSz: string | null } = { state: 'unknown', avgPx: null, fillSz: null };
  try {
    fill = await reconcileOkxOrder(apiKey, apiSecret, apiPassphrase, instId, String(ordId), isTestnet);
  } catch (e) {
    // LOCAL FIX: an unreconcilable order is still a placed order — report it
    // with state 'unknown' instead of throwing past the caller.
    console.error(`liveOrderExecution: OKX reconciliation failed for order ${String(ordId)}: ${e instanceof Error ? e.message : 'unknown error'}`);
  }

  if (fill.state === 'filled') {
    const fillPrice = parseFloat(fill.avgPx) || (px ? parseFloat(px) : 0);
    await tryTradeUpdate(base44, tradeId, {
      status: 'completed', price: fillPrice, total_value: fillPrice * sizeCheck.value,
    }, 'OKX fill');
  } else if (fill.state === 'canceled') {
    await tryTradeUpdate(base44, tradeId, { status: 'cancelled' }, 'OKX cancel');
  }

  return Response.json({
    success: true, order_id: ordId, trade_id: tradeId, state: fill.state,
    avg_fill_price: fill.avgPx ? parseFloat(fill.avgPx) : null,
    fill_quantity: fill.fillSz ? parseFloat(fill.fillSz) : null,
    is_testnet: isTestnet,
  });
}

async function reconcileOkxOrder(
  apiKey: string, apiSecret: string, passphrase: string,
  instId: string, ordId: string, isTestnet: boolean
): Promise<{ state: string; avgPx: string | null; fillSz: string | null }> {
  const requestPath = `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`;
  const headers = await buildOkxHeaders(apiKey, apiSecret, passphrase, 'GET', requestPath, '', isTestnet);

  // LOCAL FIX: goes through fetchExchangeJson so a bad body degrades to
  // state 'unknown' rather than throwing after the order is already live.
  const res = await fetchExchangeJson(`${OKX_URL}${requestPath}`, { headers });
  if (res.parseFailed || !res.data || res.data.code !== '0' || !res.data.data?.[0]) {
    return { state: 'unknown', avgPx: null, fillSz: null };
  }

  const order = res.data.data[0];
  return { state: order.state || 'unknown', avgPx: order.avgPx || null, fillSz: order.fillSz || null };
}

// ---------------------------------------------------------------------------
// Kraken order path (Phase 2: live with safety layer — no testnet exists)
// ---------------------------------------------------------------------------

async function executeKrakenOrder(base44: any, params: any): Promise<Response> {
  const {
    apiKey, apiSecret, asset_symbol, side, order_type,
    quantity, price, dry_run, confirm_live, actingEmail,
  } = params;

  // --- Dry run: verify credentials via read-only Balance endpoint ---
  if (dry_run) {
    if (isKrakenLockedOut()) {
      const secs = Math.ceil(getKrakenLockoutRemainingMs() / 1000);
      return Response.json({
        success: false,
        error: `Kraken is rate-limiting this API key. Please wait ~${secs}s before retrying.`,
        rate_limited: true,
      }, { status: 429 });
    }

    const urlPath = '/0/private/Balance';
    const postData = buildKrakenBody({});
    const headers = await buildKrakenHeaders(apiKey, apiSecret, urlPath, postData);
    // LOCAL FIX: through fetchExchangeJson — an HTML/empty body used to throw.
    const data = await fetchExchangeJson(`${KRAKEN_URL}${urlPath}`, { method: 'POST', headers, body: postData });

    if (data.parseFailed || !data.data) {
      return Response.json({
        success: false,
        error: `Kraken credential test failed: ${data.transportError ? clampErrorText(data.transportError) : `unreadable response (HTTP ${data.status})`}`,
      }, { status: 400 });
    }
    if (data.data.error && data.data.error.length > 0) {
      if (isKrakenLockoutError(data.data.error)) {
        recordKrakenLockout();
        const secs = Math.ceil(getKrakenLockoutRemainingMs() / 1000);
        return Response.json({
          success: false,
          error: `Kraken is rate-limiting this API key. Please wait ~${secs}s before retrying.`,
          rate_limited: true,
        }, { status: 429 });
      }
      return Response.json({
        success: false,
        error: `Kraken credential test failed: ${clampErrorText(data.data.error.join(', '))}`,
      }, { status: 400 });
    }

    return Response.json({
      success: true, dry_run: true,
      message: 'Credentials valid — no order was placed.',
    });
  }

  // --- Safety: require explicit confirmation for live orders ---
  if (!confirm_live) {
    return Response.json({
      success: false,
      error: 'Kraken has no testnet. Set confirm_live=true to place a live order.',
    }, { status: 403 });
  }

  // LOCAL FIX: Kraken pair rules (ordermin + lot_decimals from the public
  // AssetPairs endpoint) are fetched ONCE per execution run and enforced
  // before the order is signed. Kraken rejects volumes with excess precision
  // outright, so the raw float used to bounce real orders.
  const rulesCache = new Map<string, RulesResult>();
  const rulesResult = await fetchKrakenPairRules(asset_symbol, rulesCache);
  if (!rulesResult.ok) {
    return Response.json({ success: false, error: rulesResult.reason }, { status: 400 });
  }
  const rules = rulesResult.rules;
  const baseCcy = asset_symbol.split('/')[0] || 'base currency';

  // LOCAL FIX: round volume DOWN to lot_decimals and enforce ordermin BEFORE
  // sending. Rounding down — never up — so the order never exceeds the
  // caller's intended notional.
  const sizeCheck = enforceOrderSize(Number(quantity), rules, 'Kraken (ordermin)', baseCcy);
  if (!sizeCheck.ok) {
    return Response.json({ success: false, error: sizeCheck.error }, { status: 400 });
  }
  const volume = sizeCheck.sz;

  // LOCAL FIX: limit prices rounded to pair_decimals with a direction bias
  // (buy rounds down, sell rounds up), matching the OKX path.
  let priceStr: string | null = null;
  if (order_type === 'limit') {
    priceStr = roundPriceToTick(Number(price), rules.priceIncrement, rules.priceDecimals, side);
    if (!(parseFloat(priceStr) > 0)) {
      return Response.json({ success: false, error: `Limit price ${price} rounds down to zero at Kraken pair precision ${rules.priceDecimals} decimals. Nothing was sent.` }, { status: 400 });
    }
  }

  // --- Map to Kraken AddOrder params ---
  const orderParams: Record<string, string> = {
    pair: asset_symbol,
    type: side,
    ordertype: order_type,
    volume, // LOCAL FIX: rounded to the pair's lot_decimals, not the raw float
  };
  if (order_type === 'limit') {
    orderParams.price = priceStr as string;
  }

  if (isKrakenLockedOut()) {
    const secs = Math.ceil(getKrakenLockoutRemainingMs() / 1000);
    return Response.json({
      success: false,
      error: `Kraken is rate-limiting this API key. Please wait ~${secs}s before retrying.`,
      rate_limited: true,
    }, { status: 429 });
  }

  const urlPath = '/0/private/AddOrder';
  const postData = buildKrakenBody(orderParams);
  const headers = await buildKrakenHeaders(apiKey, apiSecret, urlPath, postData);

  // LOCAL FIX: through fetchExchangeJson so a bad body becomes a structured
  // "state unknown" refusal instead of a thrown generic 500.
  const data = await fetchExchangeJson(`${KRAKEN_URL}${urlPath}`, { method: 'POST', headers, body: postData });
  if (data.parseFailed || !data.data) {
    return Response.json({
      success: false,
      error: `Kraken order response was unreadable (HTTP ${data.status}${data.transportError ? `: ${clampErrorText(data.transportError)}` : ''}) — the order state at Kraken is unknown. Check Open Orders before retrying.`,
    }, { status: 502 });
  }

  if (data.data.error && data.data.error.length > 0) {
    if (isKrakenLockoutError(data.data.error)) {
      recordKrakenLockout();
      const secs = Math.ceil(getKrakenLockoutRemainingMs() / 1000);
      return Response.json({
        success: false,
        error: `Kraken is rate-limiting this API key. Please wait ~${secs}s before retrying.`,
        rate_limited: true,
      }, { status: 429 });
    }
    return Response.json({
      success: false,
      error: `Kraken rejected the order: ${clampErrorText(data.data.error.join(', '))}`,
    }, { status: 400 });
  }

  const txid = data.data.result?.txid?.[0];
  if (!txid) {
    return Response.json({ success: false, error: 'Kraken accepted but returned no order ID' }, { status: 500 });
  }

  // LOCAL FIX: the order is already live here — persistence is best-effort.
  let tradeId: string | null = null;
  try {
    const trade = await base44.asServiceRole.entities.Trade.create({
      asset_symbol, trade_type: side, quantity: sizeCheck.value,
      price: priceStr ? parseFloat(priceStr) : 0,
      total_value: priceStr ? parseFloat(priceStr) * sizeCheck.value : 0,
      exchange: 'kraken', status: 'pending', owner_email: actingEmail,
    });
    tradeId = trade?.id ?? null;
  } catch (e) {
    console.error(`liveOrderExecution: Kraken order ${String(txid)} placed but the Trade record could not be created: ${e instanceof Error ? e.message : 'unknown error'}`);
  }

  let fill: { status: string; price: string | null; vol_exec: string | null } = { status: 'unknown', price: null, vol_exec: null };
  try {
    fill = await reconcileKrakenOrder(apiKey, apiSecret, String(txid));
  } catch (e) {
    // LOCAL FIX: an unreconcilable order is still a placed order.
    console.error(`liveOrderExecution: Kraken reconciliation failed for order ${String(txid)}: ${e instanceof Error ? e.message : 'unknown error'}`);
  }

  if (fill.status === 'closed') {
    const fillPrice = parseFloat(fill.price) || (priceStr ? parseFloat(priceStr) : 0);
    const fillQty = parseFloat(fill.vol_exec) || sizeCheck.value;
    await tryTradeUpdate(base44, tradeId, {
      status: 'completed', price: fillPrice, total_value: fillPrice * fillQty,
    }, 'Kraken fill');
  } else if (fill.status === 'canceled' || fill.status === 'expired') {
    await tryTradeUpdate(base44, tradeId, { status: 'cancelled' }, 'Kraken cancel');
  }

  return Response.json({
    success: true, order_id: txid, trade_id: tradeId, state: fill.status,
    avg_fill_price: fill.price ? parseFloat(fill.price) : null,
    fill_quantity: fill.vol_exec ? parseFloat(fill.vol_exec) : null,
    exchange: 'kraken',
  });
}

async function reconcileKrakenOrder(
  apiKey: string, apiSecret: string, txid: string
): Promise<{ status: string; price: string | null; vol_exec: string | null }> {
  const urlPath = '/0/private/QueryOrders';
  const postData = buildKrakenBody({ txid });
  const headers = await buildKrakenHeaders(apiKey, apiSecret, urlPath, postData);

  // LOCAL FIX: through fetchExchangeJson — degrades to 'unknown', never throws.
  const data = await fetchExchangeJson(`${KRAKEN_URL}${urlPath}`, { method: 'POST', headers, body: postData });
  if (!data.data) {
    return { status: 'unknown', price: null, vol_exec: null };
  }

  if (data.data.error && data.data.error.length > 0) {
    // Error codes are logged for diagnosis; they are Kraken's own short codes
    // and never credential material.
    console.error(`liveOrderExecution: Kraken QueryOrders error: ${clampErrorText(data.data.error.join(', '))}`);
    return { status: 'unknown', price: null, vol_exec: null };
  }
  if (!data.data.result) {
    return { status: 'unknown', price: null, vol_exec: null };
  }

  const order = data.data.result[txid];
  if (!order) {
    return { status: 'unknown', price: null, vol_exec: null };
  }

  return {
    status: order.status || 'unknown', // pending, open, closed, canceled, expired
    price: order.price || null,
    vol_exec: order.vol_exec || null,
  };
}
