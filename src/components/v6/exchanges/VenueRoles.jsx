import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { V6Card } from '@/components/v6/shared';
import { REPLAY_VENUES, enabledVenues } from './venueDraft';

function RoleRow({ label, children }) {
  return (
    <div className="flex flex-col gap-1 border-t border-slate-800 py-2 first:border-t-0 sm:flex-row sm:items-center">
      <dt className="text-sm text-slate-400 sm:w-64 sm:shrink-0">{label}</dt>
      <dd className="min-w-0 text-sm text-slate-200">{children}</dd>
    </div>
  );
}

function VenueSelect({ label, value, options, labelOf, onChange }) {
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="h-8 w-44 border-slate-700 bg-slate-900">
        <SelectValue placeholder="Not set" />
      </SelectTrigger>
      <SelectContent>
        {options.map((id) => <SelectItem key={id} value={id}>{labelOf(id)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export default function VenueRoles({ draft, minForConsensus, labelOf, onRole }) {
  const on = enabledVenues(draft);
  const [primary, ...backups] = on;
  return (
    <V6Card title="Which venue does what">
      <dl>
        <RoleRow label="Bars for signals">
          {primary ? labelOf(primary) : 'None'}
          {backups.length > 0 && `, then failover to ${backups.map(labelOf).join(', ')}`}
          <span className="block text-xs text-slate-500">Follows the priority order above.</span>
        </RoleRow>
        <RoleRow label="Cross-venue replay (test 4)">
          <VenueSelect
            label="Replay venue" value={draft.roles.replay} options={REPLAY_VENUES}
            labelOf={labelOf} onChange={(id) => onRole('replay', id)}
          />
          <span className="mt-1 block text-xs text-slate-500">
            OKX or Bybit only: they are the venues with stored replay history.
          </span>
        </RoleRow>
        <RoleRow label="Price consensus (test 3)">
          {on.map(labelOf).join(', ') || 'None'}
          <span className="block text-xs text-slate-500">
            Every enabled venue votes once it has answered. Needs at least {minForConsensus}.
          </span>
        </RoleRow>
        <RoleRow label="Order book, liquidity (test 5)">
          <VenueSelect
            label="Order book venue" value={draft.roles.book} options={on}
            labelOf={labelOf} onChange={(id) => onRole('book', id)}
          />
        </RoleRow>
        <RoleRow label="Paper fills">Simulated from the book above. No real order is sent.</RoleRow>
      </dl>
    </V6Card>
  );
}
