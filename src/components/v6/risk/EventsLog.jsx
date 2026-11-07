// Recent changes and events, from V6RiskEvent through the `events` action.
import React from 'react';
import { AlertOctagon, AlertTriangle } from 'lucide-react';
import { QueryState, StaleSince, V6Card } from '../shared/StateCard';
import { ToneBadge } from '../shared/ToneBadge';
import { useV6Query } from '../shared/useV6';
import { utc } from '../shared/format';

const SEVERITY = {
  warning: { tone: 'amber', icon: AlertTriangle, label: 'Warning' },
  critical: { tone: 'red', icon: AlertOctagon, label: 'Critical' },
};

export default function EventsLog() {
  const events = useV6Query('events', { limit: 20 });
  return (
    <V6Card title="Recent changes and events" actions={<StaleSince query={events} />}>
      <QueryState
        query={events}
        errorLabel="Could not load events"
        isEmpty={(d) => !d.items?.length}
        empty="No changes or events yet."
      >
        {(data) => (
          <ul>
            {data.items.map((e) => {
              const severity = SEVERITY[e.severity];
              return (
                <li key={e.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-slate-800 py-2 text-sm first:border-t-0">
                  <span className="w-36 shrink-0 text-xs leading-5 text-slate-400">{utc(e.t)}</span>
                  {severity && (
                    <ToneBadge tone={severity.tone} icon={severity.icon}>
                      {severity.label}
                    </ToneBadge>
                  )}
                  <p className="min-w-0 flex-1 basis-56 text-slate-300">{e.message}</p>
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </V6Card>
  );
}
