// The four tiles. Vs BTC is neutral text with a sign and must show when V6 is behind, with
// no excuses. Drawdown leads with the all-time figure, because the ladder's own figure
// resets at each re-enable (contract section 6).
import React from 'react';
import StatTile from '../shared/StatTile';
import { allTimeLabel } from '../shared/useAllTimeDrawdown';
import { money, pct, pnlCls, pts, signedPct, utcDate } from '../shared/format';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function reenableNote(allTime) {
  if (!isNum(allTime.reenables)) return null;
  if (allTime.reenables === 0) return 'No re-enables so far';
  return `Across ${allTime.reenables} re-enable${allTime.reenables === 1 ? '' : 's'}`;
}

function DrawdownTile({ risk, allTime, stale }) {
  const failSafe = risk?.halted?.source === 'fail_safe';
  const parts = [];
  if (isNum(risk?.worstDrawdownPct)) parts.push(`Worst ${pct(risk.worstDrawdownPct)}`);
  const note = reenableNote(allTime);
  if (note) parts.push(note);

  return (
    <StatTile
      label="Drawdown from all-time high"
      value={allTimeLabel(allTime, pct) ?? 'Unknown'}
      loading={allTime.loading}
      stale={stale}
      sub={
        failSafe
          ? 'Stored risk state could not be read'
          : allTime.known
            ? `All-time high ${money(allTime.highEquity)}`
            : 'Equity history is not available'
      }
      sub2={parts.join('. ') || null}
    />
  );
}

export default function MissionTiles({ status, allTime, stale }) {
  const { account, risk, positions } = status;
  const flat = !positions?.length;
  const ret = account?.equityReturnPct;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile
        label="Paper equity"
        value={money(account?.equity)}
        stale={stale}
        sub={
          flat ? (
            '100% cash'
          ) : (
            <span className={pnlCls(ret)}>{signedPct(ret)} all time</span>
          )
        }
        sub2={flat && isNum(ret) && ret !== 0 ? `${signedPct(ret)} all time` : null}
      />
      <StatTile
        label="Vs BTC hold"
        value={isNum(account?.vsBtcPts) ? pts(account.vsBtcPts) : 'Not enough data'}
        stale={stale}
        sub={isNum(account?.vsBtcPts) ? `since ${utcDate(account.startedAt)}` : 'The comparison starts after the first day'}
        sub2={
          isNum(account?.vsBtcPts)
            ? `V6 ${signedPct(account.equityReturnPct)}, BTC ${signedPct(account.btcReturnPct)} with no fees`
            : null
        }
      />
      <DrawdownTile risk={risk} allTime={allTime} stale={stale} />
      <StatTile
        label="Exposure"
        value={pct(account?.grossExposurePct, 0)}
        stale={stale}
        sub={`Open risk ${pct(account?.openRiskPct)} of equity`}
      />
    </div>
  );
}
