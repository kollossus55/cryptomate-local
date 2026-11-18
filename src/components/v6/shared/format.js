// Display helpers for V6 pages. Every one returns the dash for a missing number, so a
// gap in the data can never render as 0 or NaN.
import { formatDistanceToNowStrict } from 'date-fns';

export const DASH = '—';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function money(v, { decimals = 0 } = {}) {
  if (!isNum(v)) return DASH;
  const body = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${v < 0 ? '-' : ''}$${body}`;
}

/** Signed dollars, for P&L. */
export function signedMoney(v, opts) {
  if (!isNum(v)) return DASH;
  return `${v > 0 ? '+' : ''}${money(v, opts)}`;
}

/** Plain percent, sign only when negative. Input is a display number: -3.2 means -3.2%. */
export function pct(v, d = 1) {
  return isNum(v) ? `${v.toFixed(d)}%` : DASH;
}

/** Percent that always carries its sign. */
export function signedPct(v, d = 1) {
  return isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}%` : DASH;
}

export function pts(v, d = 1) {
  return isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)} pts` : DASH;
}

export function rMultiple(v) {
  return isNum(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}R` : DASH;
}

/** Prices span 100,000 to 0.0001, so the decimals follow the size. */
export function price(v) {
  if (!isNum(v)) return DASH;
  const a = Math.abs(v);
  const decimals = a >= 1000 ? 0 : a >= 10 ? 2 : a >= 0.1 ? 4 : 6;
  return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function qty(v) {
  return isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 6 }) : DASH;
}

/** 'ETHUSDT' or 'ETH-USDT' -> 'ETH'. */
export const coin = (symbol) => String(symbol ?? DASH).replace(/[-/]?(USDT|USDC|USD)$/i, '') || String(symbol);

/** P&L colour. Only for profit and loss: emerald never means "good trade" (gui-design 3). */
export const pnlCls = (v) => (!isNum(v) || v === 0 ? 'text-slate-300' : v > 0 ? 'text-emerald-400' : 'text-red-400');

export function ago(t) {
  if (!isNum(t)) return DASH;
  return `${formatDistanceToNowStrict(new Date(t))} ago`;
}

export function until(t) {
  if (!isNum(t)) return DASH;
  return formatDistanceToNowStrict(new Date(t));
}

// date-fns format() is local time. Day boundaries here are UTC, so format in UTC.
const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts });
const DATE = fmt({ day: 'numeric', month: 'short' });
const DATE_YEAR = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
const TIME = fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const utcDate = (t) => (isNum(t) ? DATE.format(t) : DASH);
export const utcDateYear = (t) => (isNum(t) ? DATE_YEAR.format(t) : DASH);
export const utcTime = (t) => (isNum(t) ? TIME.format(t) : DASH);
/** "14 Nov 09:20 UTC" */
export const utc = (t) => (isNum(t) ? `${DATE.format(t)} ${TIME.format(t)} UTC` : DASH);
