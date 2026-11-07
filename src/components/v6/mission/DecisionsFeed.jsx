// Today's decisions, in UTC. Blocked rows are amber rather than red: a blocked entry is the
// gate doing its job, and red stays reserved for alarms.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, CircleSlash, Eye, LogIn, LogOut, Minus } from 'lucide-react';
import { createPageUrl } from '@/components/utils';
import SegmentedTabs from '../shared/SegmentedTabs';
import { EmptyNote, QueryState, StaleSince, V6Card } from '../shared/StateCard';
import { ToneBadge } from '../shared/ToneBadge';
import { useV6Query } from '../shared/useV6';
import { coin, pnlCls, signedMoney, utcTime } from '../shared/format';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'entry', label: 'Entries' },
  { value: 'exit', label: 'Exits' },
  { value: 'blocked', label: 'Blocked' },
];

const KIND = {
  entered: { label: 'ENTERED', tone: 'indigo', icon: LogIn },
  exit: { label: 'EXIT', tone: 'slate', icon: LogOut },
  reduce: { label: 'REDUCED', tone: 'slate', icon: Minus },
  blocked: { label: 'BLOCKED', tone: 'amber', icon: Ban },
  shadow: { label: 'SHADOW', tone: 'amber', icon: Eye },
  not_tested: { label: 'NOT TESTED', tone: 'slate', icon: CircleSlash },
};

function Decision({ item }) {
  const kind = KIND[item.kind] ?? { label: String(item.kind).toUpperCase(), tone: 'slate' };
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-slate-800 py-2 text-sm first:border-t-0">
      <span className="w-11 shrink-0 text-xs leading-5 text-slate-400">{utcTime(item.t)}</span>
      <ToneBadge tone={kind.tone} icon={kind.icon}>
        {kind.label}
      </ToneBadge>
      <p className="min-w-0 flex-1 basis-56 text-slate-300">
        {item.symbol && <span className="font-medium text-slate-100">{coin(item.symbol)} </span>}
        {item.text}
      </p>
      {typeof item.pnl === 'number' && (
        <span className={`text-xs leading-5 ${pnlCls(item.pnl)}`}>{signedMoney(item.pnl)} paper</span>
      )}
    </li>
  );
}

/** Wording for an all-quiet day. Being quiet is a normal result, so it reads calmly. */
export function quietDayText(engineHasRun) {
  return engineHasRun ? 'The engine ran, and no strategy produced a signal.' : 'Waiting for the first engine run.';
}

function LeadIn({ items }) {
  if (items.some((i) => ['entered', 'exit', 'reduce', 'blocked'].includes(i.kind))) return null;
  const shadow = items.filter((i) => i.kind === 'shadow').length;
  if (!shadow) return null;
  return (
    <p className="pb-2 text-sm text-slate-400">
      No entries today. {shadow} shadow signal{shadow === 1 ? '' : 's'} logged.
    </p>
  );
}

export default function DecisionsFeed({ engineHasRun }) {
  const [kind, setKind] = useState('all');
  const decisions = useV6Query('decisions', { kind, limit: 50 });

  return (
    <V6Card
      title="Today's decisions (UTC)"
      actions={
        <div className="flex items-center gap-2">
          <StaleSince query={decisions} />
          <SegmentedTabs value={kind} onChange={setKind} options={FILTERS} label="Filter decisions" />
        </div>
      }
    >
      <QueryState
        query={decisions}
        errorLabel="Could not load decisions"
        isEmpty={(d) => !d.items?.length}
        empty={<EmptyNote>{kind === 'all' ? quietDayText(engineHasRun) : 'Nothing of this kind today.'}</EmptyNote>}
      >
        {(data) => (
          <>
            {kind === 'all' && <LeadIn items={data.items} />}
            <ul className={decisions.isPlaceholderData ? 'opacity-60' : ''}>
              {data.items.map((item, i) => (
                <Decision key={`${item.t}-${item.symbol}-${item.kind}-${i}`} item={item} />
              ))}
            </ul>
          </>
        )}
      </QueryState>
      <div className="pt-2 text-right">
        <Link to={createPageUrl('SignalTests')} className="text-xs text-slate-300 underline underline-offset-2">
          All signal tests
        </Link>
      </div>
    </V6Card>
  );
}
