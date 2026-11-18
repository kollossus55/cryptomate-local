import React from 'react';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { DASH, QueryState, SkeletonRows, StaleSince, ToneBadge, V6Card, coin, pct, price } from '@/components/v6/shared';
import { consensusView, quoteMap } from './venueDraft';

const ICONS = { ok: CheckCircle2, warn: AlertTriangle, bad: XCircle };

function Table({ data, venues, labelOf }) {
  const peg = data.items.some((i) => i.pegAlarm);
  return (
    <>
      {peg && (
        <p role="alert" className="mb-2 flex items-center gap-2 text-sm text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          USDT is off its peg. USD venues are converted using the current rate.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400">
              <th className="py-2 pr-3 font-medium">Coin</th>
              <th className="py-2 pr-3 font-medium">Consensus</th>
              {venues.map((id) => <th key={id} className="py-2 pr-3 font-medium">{labelOf(id)}</th>)}
              <th className="py-2 pr-3 font-medium">Spread</th>
              <th className="py-2 pr-3 font-medium">Limit</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => {
              const quotes = quoteMap(item.quotes);
              const view = consensusView(item, { labelOf });
              return (
                <tr key={item.symbol} className="border-t border-slate-800 text-slate-200">
                  <td className="py-2 pr-3 font-medium">{coin(item.symbol)}</td>
                  <td className={`py-2 pr-3 ${item.ok ? '' : 'text-slate-400'}`}>{price(item.price)}</td>
                  {venues.map((id) => (
                    <td key={id} className="py-2 pr-3">{quotes[id] == null ? DASH : price(quotes[id])}</td>
                  ))}
                  <td className="py-2 pr-3">{pct(item.spreadPct, 2)}</td>
                  <td className="py-2 pr-3">{pct(data.tolerancePct, 2)}</td>
                  <td className="py-2">
                    <ToneBadge tone={view.tone} icon={ICONS[view.state]} className="whitespace-nowrap">{view.label}</ToneBadge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        Disagreeing or stale data stops new entries. Exits continue. A consensus price on a row
        that does not agree is for marking positions only.
      </p>
    </>
  );
}

export default function ConsensusTable({ query, venues, labelOf }) {
  return (
    <V6Card title="Price agreement (consensus)" actions={<StaleSince query={query} />}>
      <QueryState
        query={query}
        skeleton={<SkeletonRows rows={3} />}
        errorLabel="Could not load price agreement"
        isEmpty={(d) => !d.items?.length}
        empty="No prices compared yet."
      >
        {(data) => <Table data={data} venues={venues} labelOf={labelOf} />}
      </QueryState>
    </V6Card>
  );
}
