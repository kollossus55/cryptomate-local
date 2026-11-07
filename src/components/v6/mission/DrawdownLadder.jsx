// The ladder is plain divs, not a chart (gui-design 5.1). All thresholds come from
// status.risk.ladder, so the rungs follow any tightened value. Below the track: the
// period limits, and the gap between the ladder's high and the all-time high.
import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { StaleBadge } from '../shared/ToneBadge';
import { V6Card } from '../shared/StateCard';
import { allTimeLabel } from '../shared/useAllTimeDrawdown';
import { DASH, money, pct, signedPct, until } from '../shared/format';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const SIZE_TEXT = ['Full size', 'Half size', 'Quarter size', 'No new entries', 'Flatten and halt'];
const NEXT_TEXT = ['size halves', 'size drops to a quarter', 'new entries stop', 'everything closes and V6 halts'];

export function rungsFor(ladder) {
  return [
    { rung: 0, name: 'Full size', from: 0 },
    { rung: 1, name: 'Half size', from: ladder?.halfPct },
    { rung: 2, name: 'Quarter size', from: ladder?.quarterPct },
    { rung: 3, name: 'No new entries', from: ladder?.noEntriesPct },
    { rung: 4, name: 'Flatten and halt', from: ladder?.haltPct },
  ];
}

/** Points left before the next rung, or null when there is no next rung or it has passed. */
export function pointsToNextRung(drawdownPct, rung, ladder) {
  if (!isNum(drawdownPct) || !isNum(rung) || rung >= 4) return null;
  const next = rungsFor(ladder)[rung + 1]?.from;
  if (!isNum(next)) return null;
  const gap = drawdownPct - next;
  return gap > 0 ? gap : null;
}

/** Marker position in percent of the track. The track runs a little past the halt level. */
export function trackPosition(valuePct, haltPct) {
  const span = Math.abs(haltPct) * 1.1;
  return Math.min(100, Math.max(0, (Math.abs(valuePct) / span) * 100));
}

function Track({ drawdownPct, rungs, haltPct }) {
  const known = isNum(drawdownPct);
  const left = known ? trackPosition(drawdownPct, haltPct) : null;
  return (
    <div className="px-1">
      <div className="relative mb-1 h-4 text-[11px] text-slate-400" aria-hidden="true">
        {rungs.map((r) => (
          <span
            key={r.rung}
            className="absolute -translate-x-1/2 first:translate-x-0"
            style={{ left: `${trackPosition(r.from, haltPct)}%` }}
          >
            {r.rung === 0 ? '0%' : pct(r.from, Number.isInteger(r.from) ? 0 : 1)}
          </span>
        ))}
      </div>
      <div className="relative h-2 rounded-full bg-slate-800">
        {rungs.slice(1).map((r) => (
          <span
            key={r.rung}
            className="absolute top-[-3px] h-[14px] w-px bg-slate-500"
            style={{ left: `${trackPosition(r.from, haltPct)}%` }}
            aria-hidden="true"
          />
        ))}
        {known && (
          <span
            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-900 bg-slate-100"
            style={{ left: `${left}%` }}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}

function RungList({ rungs, active }) {
  return (
    <ol className="grid grid-cols-2 gap-2 md:grid-cols-5">
      {rungs.map((r) => {
        const on = r.rung === active;
        return (
          <li
            key={r.rung}
            aria-current={on ? 'step' : undefined}
            className={`rounded-md border px-2 py-1.5 text-xs ${
              on ? 'border-slate-500 bg-slate-800 text-slate-100' : 'border-slate-800 text-slate-400'
            }`}
          >
            <span className="block font-medium">{r.name}</span>
            <span>
              {r.rung === 0 ? 'From the high' : `At ${pct(r.from, Number.isInteger(r.from) ? 0 : 1)}`}
              {on ? ', now' : ''}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** How much of a limit is used, from 0 to 100. A rise or a profit uses none of it. */
export function limitUsed(value, limit) {
  if (!isNum(value) || !isNum(limit) || limit === 0 || value >= 0) return 0;
  return Math.min(100, (value / limit) * 100);
}

function LimitMeter({ label, value, limit, note }) {
  const used = limitUsed(value, limit);
  const hit = used >= 100;
  const near = used >= 75;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-400">
          {isNum(value) ? `${signedPct(value)} of ${pct(limit)}` : 'Not available yet'}
          {hit ? ', limit reached' : ''}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800" aria-hidden="true">
        <div
          className={`h-1.5 rounded-full ${hit ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-slate-500'}`}
          style={{ width: `${used}%` }}
        />
      </div>
      {note && <p className="text-[11px] text-slate-500">{note}</p>}
    </div>
  );
}

function RebasedNote({ risk, allTime }) {
  if (!allTime.known || !isNum(risk.peakEquity) || !isNum(allTime.highEquity)) return null;
  if (risk.peakEquity >= allTime.highEquity) return null;
  return (
    <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        The ladder measures from {money(risk.peakEquity)}, set by a re-enable. The all-time high is{' '}
        {money(allTime.highEquity)}, so the account is {allTimeLabel(allTime, pct)?.toLowerCase()} from its peak.
      </span>
    </p>
  );
}

export default function DrawdownLadder({ risk, allTime, stale }) {
  const failSafe = risk?.halted?.source === 'fail_safe';
  const ladder = risk?.ladder;
  if (!ladder || !isNum(ladder.haltPct)) {
    return <V6Card title="Drawdown ladder"><p className="text-sm text-slate-400">The ladder levels are not available.</p></V6Card>;
  }

  const rungs = rungsFor(ladder);
  const drawdown = failSafe || !isNum(risk.drawdownPct) ? null : risk.drawdownPct;
  const toNext = pointsToNextRung(drawdown, risk.rung, ladder);

  return (
    <V6Card title="Drawdown ladder" actions={stale ? <StaleBadge /> : null} contentClassName="space-y-4">
      <Track drawdownPct={drawdown} rungs={rungs} haltPct={ladder.haltPct} />
      <RungList rungs={rungs} active={drawdown === null ? null : risk.rung} />

      <p className="text-sm text-slate-200">
        {drawdown === null ? (
          'The equity high is unknown, so no drawdown figure is shown.'
        ) : (
          <>
            Now: {pct(drawdown)} from the ladder high. {SIZE_TEXT[risk.rung] ?? DASH}.
            {toNext !== null && ` ${toNext.toFixed(1)} points until ${NEXT_TEXT[risk.rung]}.`}
          </>
        )}
      </p>

      <RebasedNote risk={risk} allTime={allTime} />

      <div className="grid gap-3 sm:grid-cols-2">
        <LimitMeter
          label="Daily loss (UTC)"
          value={risk.daily?.lossPct}
          limit={risk.daily?.limitPct}
          note={isNum(risk.daily?.resetsAt) ? `Resets in ${until(risk.daily.resetsAt)}` : null}
        />
        <LimitMeter
          label="Weekly loss (UTC)"
          value={risk.weekly?.lossPct}
          limit={risk.weekly?.limitPct}
          note={isNum(risk.weekly?.resetsAt) ? `Resets in ${until(risk.weekly.resetsAt)}` : null}
        />
        <LimitMeter label="BTC 24h" value={risk.btc?.chg24hPct} limit={risk.btc?.limit24hPct} />
        <LimitMeter label="BTC 7d" value={risk.btc?.chg7dPct} limit={risk.btc?.limit7dPct} />
      </div>
    </V6Card>
  );
}
