// Open positions, closest to the stop first. A missing stop is the loudest thing in the
// table: never a blank and never a zero distance (gui-design 5.1).
import React, { useMemo, useState } from 'react';
import { AlertOctagon, ChevronDown } from 'lucide-react';
import { EmptyNote, V6Card } from '../shared/StateCard';
import { StaleBadge, ToneBadge } from '../shared/ToneBadge';
import { ago, coin, DASH, pct, pnlCls, price, qty, rMultiple, signedMoney, money } from '../shared/format';

const NEAR_STOP_PCT = 2;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const hasStop = (p) => isNum(p.stopPrice);

/** Price at or through the stop, waiting for the next engine run to close it. */
export function stopPassed(p) {
  if (!hasStop(p) || !isNum(p.lastPrice)) return false;
  return p.side === 'short' ? p.lastPrice >= p.stopPrice : p.lastPrice <= p.stopPrice;
}

/** No stop first, then any stop already passed, then the smallest distance to the stop. */
export function sortPositions(positions) {
  const urgency = (p) => (!hasStop(p) ? 0 : stopPassed(p) ? 1 : 2);
  const distance = (p) => (hasStop(p) && isNum(p.distanceToStopPct) ? Math.abs(p.distanceToStopPct) : Infinity);
  return [...(positions ?? [])].sort((a, b) => urgency(a) - urgency(b) || distance(a) - distance(b));
}

const PLAN_STATE = {
  armed: { text: 'armed', tone: 'slate' },
  active: { text: 'active', tone: 'indigo' },
  waiting: { text: 'waiting', tone: 'slate' },
  done: { text: 'done', tone: 'slate' },
  off: { text: 'off', tone: 'slate' },
};

const WARNING_TEXT = {
  no_stop_given: 'No stop was given when this position opened.',
};

const warningText = (code) => WARNING_TEXT[code] ?? `Exit plan warning: ${String(code).replace(/_/g, ' ')}.`;

function ExitPlan({ position }) {
  const rows = position.exitPlan ?? [];
  return (
    <div className="space-y-2 bg-slate-950/40 px-3 py-3">
      <p className="text-xs text-slate-400">
        Exit plan{position.exitProfile ? ` (profile: ${position.exitProfile})` : ''}. Exits are never blocked.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-amber-300">No exit plan is stored for this position.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th scope="col">Exit</th>
              <th scope="col">Level</th>
              <th scope="col">State</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const state = PLAN_STATE[row.state] ?? { text: row.state, tone: 'slate' };
              return (
                <tr key={row.id} className={row.state === 'off' ? 'text-slate-500' : 'text-slate-300'}>
                  <td className="py-0.5 pr-3 whitespace-nowrap">{row.label}</td>
                  <td className="py-0.5 pr-3 whitespace-nowrap">{isNum(row.level) ? price(row.level) : row.level ?? DASH}</td>
                  <td className="py-0.5 pr-3">
                    <ToneBadge tone={state.tone}>{state.text}</ToneBadge>
                  </td>
                  <td className="py-0.5 text-xs text-slate-400">{row.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {(position.exitWarnings ?? []).map((code) => (
        <p key={code} className="text-xs text-amber-300">
          {warningText(code)}
        </p>
      ))}
    </div>
  );
}

function StopCells({ position }) {
  if (!hasStop(position)) {
    return (
      <>
        <td className="px-2 py-2" colSpan={2}>
          <ToneBadge tone="red" icon={AlertOctagon}>
            NO STOP
          </ToneBadge>
        </td>
        <td className="hidden md:table-cell px-2 py-2 text-slate-400">{DASH}</td>
      </>
    );
  }
  // Shown as a size. The sign differs by side, and stopPassed covers the one case it matters.
  const distance = isNum(position.distanceToStopPct) ? Math.abs(position.distanceToStopPct) : null;
  const passed = stopPassed(position);
  const near = passed || (distance !== null && distance < NEAR_STOP_PCT);
  return (
    <>
      <td className="px-2 py-2 whitespace-nowrap text-slate-300">{price(position.stopPrice)}</td>
      <td className={`px-2 py-2 whitespace-nowrap ${near ? 'text-amber-300' : 'text-slate-300'}`}>
        {pct(distance)}
        {near && <span className="ml-1 text-xs">{passed ? 'past stop' : 'near stop'}</span>}
      </td>
      <td className="hidden md:table-cell px-2 py-2 whitespace-nowrap text-slate-300">{money(position.riskToStop)}</td>
    </>
  );
}

function PositionRow({ position, open, onToggle }) {
  const key = `${position.symbol}-${position.strategyId}`;
  const short = position.side === 'short';
  const perp = position.instrument && position.instrument !== 'spot';
  return (
    <>
      <tr className="border-t border-slate-800 align-top">
        <td className="px-2 py-2 whitespace-nowrap font-medium text-slate-100">
          {coin(position.symbol)}
          {short && <span className="ml-1 text-xs font-normal text-slate-400">short</span>}
          {perp && <span className="ml-1 text-xs font-normal text-slate-400">{position.instrument}</span>}
          {position.stale && (
            <span className="ml-1 md:hidden">
              <StaleBadge />
            </span>
          )}
        </td>
        <td className="hidden md:table-cell px-2 py-2 text-slate-300">
          {position.adopted || position.strategyId === 'legacy'
            ? 'Adopted from old engine'
            : position.strategyName ?? position.strategyId}
        </td>
        <td className="hidden md:table-cell px-2 py-2 whitespace-nowrap text-slate-300">{qty(position.qty)}</td>
        <td className="hidden md:table-cell px-2 py-2 whitespace-nowrap text-slate-300">{price(position.entryPrice)}</td>
        <td className="hidden md:table-cell px-2 py-2 whitespace-nowrap text-slate-300">
          {price(position.lastPrice)}
          {position.stale && (
            <span className="mt-1 block">
              <StaleBadge />
              {isNum(position.priceAgeSec) && (
                <span className="mt-0.5 block text-xs text-slate-400">
                  last good price {ago(Date.now() - position.priceAgeSec * 1000)}
                </span>
              )}
            </span>
          )}
        </td>
        <td className={`px-2 py-2 whitespace-nowrap ${pnlCls(position.unrealized)}`}>
          {signedMoney(position.unrealized)}
          {isNum(position.rMultiple) && <span className="ml-1 text-xs">({rMultiple(position.rMultiple)})</span>}
          {perp && isNum(position.fundingAccrued) && (
            <span className="block text-xs text-slate-400">Funding {signedMoney(position.fundingAccrued, { decimals: 2 })}</span>
          )}
        </td>
        <StopCells position={position} />
        <td className="px-2 py-2 text-right">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={`exit-${key}`}
            aria-label={`${open ? 'Hide' : 'Show'} exit plan for ${coin(position.symbol)}`}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        </td>
      </tr>
      {position.nextExit && (
        <tr>
          <td colSpan={10} className="px-2 pb-2 text-xs text-slate-400">
            next: {position.nextExit}
          </td>
        </tr>
      )}
      {open && (
        <tr id={`exit-${key}`}>
          <td colSpan={10} className="p-0">
            {/* The columns a phone leaves out, so nothing is lost at that width. */}
            <p className="px-2 pb-1 text-xs text-slate-400 md:hidden">
              {position.strategyName ?? position.strategyId}. Qty {qty(position.qty)}, entry {price(position.entryPrice)}, now{' '}
              {price(position.lastPrice)}, risk to stop {money(position.riskToStop)}.
            </p>
            <ExitPlan position={position} />
          </td>
        </tr>
      )}
    </>
  );
}

// A phone keeps what matters most: how the position stands and how far the stop is.
const PHONE_COLUMNS = new Set(['Coin', 'Paper P&L', 'Stop', 'To stop']);

export default function PositionsTable({ positions, quarantined = 0, stale }) {
  const [openKey, setOpenKey] = useState(null);
  const sorted = useMemo(() => sortPositions(positions), [positions]);

  return (
    <V6Card title={`Open positions (${sorted.length})`} actions={stale ? <StaleBadge /> : null}>
      {sorted.length === 0 ? (
        <EmptyNote>{quarantined ? 'No readable positions. The unreadable rows are listed at the top of this page.' : 'No open positions.'}</EmptyNote>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400">
                {['Coin', 'Strategy', 'Qty', 'Entry', 'Now', 'Paper P&L', 'Stop', 'To stop', 'Risk'].map((h) => (
                  <th key={h} scope="col" className={`${PHONE_COLUMNS.has(h) ? '' : 'hidden md:table-cell '}px-2 py-1 font-medium whitespace-nowrap`}>
                    {h}
                  </th>
                ))}
                <th scope="col">
                  <span className="sr-only">Exit plan</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => {
                const key = `${p.symbol}-${p.strategyId}`;
                return (
                  <PositionRow
                    key={key}
                    position={p}
                    open={openKey === key}
                    onToggle={() => setOpenKey(openKey === key ? null : key)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </V6Card>
  );
}
