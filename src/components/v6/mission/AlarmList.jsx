// Alarms come from V6RiskEvent only, so each one traces to a real event (contract section
// 6, I10). Hidden when nothing is open. A failed read is shown, because silence here would
// look like "no alarms".
import React from 'react';
import { AlertOctagon, AlertTriangle, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { InlineError, V6Card } from '../shared/StateCard';
import { ToneBadge } from '../shared/ToneBadge';
import { useV6Mutation, useV6Query } from '../shared/useV6';
import { utc } from '../shared/format';

/** Critical alarms stay until the condition clears, even if acknowledged (gui-design 5.1). */
export function openAlarms(items) {
  return (items ?? []).filter((e) => {
    if (e.severity !== 'warning' && e.severity !== 'critical') return false;
    if (e.clearedAt) return false;
    return e.severity === 'critical' || !e.ackedAt;
  });
}

function AlarmRow({ alarm, onAck, acking }) {
  const critical = alarm.severity === 'critical';
  return (
    <li className="flex flex-wrap items-start gap-3 border-t border-slate-800 py-2 first:border-t-0">
      <ToneBadge tone={critical ? 'red' : 'amber'} icon={critical ? AlertOctagon : AlertTriangle}>
        {critical ? 'Critical' : 'Warning'}
      </ToneBadge>
      <div className="min-w-0 flex-1 text-sm">
        <p className="text-slate-200">{alarm.message}</p>
        <p className="text-xs text-slate-400">{utc(alarm.t)}</p>
      </div>
      {alarm.ackedAt ? (
        <span className="inline-flex items-center gap-1 text-xs text-slate-400">
          <Check className="h-3.5 w-3.5" aria-hidden="true" /> Acknowledged, stays until cleared
        </span>
      ) : (
        <Button size="sm" variant="outline" className="h-7 border-slate-700 text-xs" disabled={acking} onClick={onAck}>
          {acking && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" aria-hidden="true" />}
          Acknowledge
        </Button>
      )}
    </li>
  );
}

export default function AlarmList({ engine }) {
  const { toast } = useToast();
  const events = useV6Query('events', { onlyOpen: true, limit: 50 });
  const ack = useV6Mutation('ackEvent', { invalidates: ['events', 'status'] });

  const alarms = openAlarms(events.data?.items);
  const engineFault = engine?.lastTickOk === false;

  if (events.isError && !events.data) {
    return (
      <V6Card title="Alarms">
        <InlineError error={events.error} label="Could not load alarms" onRetry={() => events.refetch()} />
      </V6Card>
    );
  }
  if (!alarms.length && !engineFault) return null;

  const acknowledge = (id) =>
    ack.mutate(
      { id },
      {
        onSuccess: () => toast({ title: 'Alarm acknowledged' }),
        onError: (err) => toast({ title: 'Could not acknowledge', description: err.message, variant: 'destructive' }),
      },
    );

  return (
    <V6Card title="Alarms">
      <ul>
        {engineFault && (
          <li className="flex items-start gap-3 py-2">
            <ToneBadge tone="red" icon={AlertOctagon}>
              Critical
            </ToneBadge>
            <p className="min-w-0 flex-1 text-sm text-slate-200">
              The last engine run failed: {engine.lastError ?? 'no detail was recorded'}
            </p>
          </li>
        )}
        {alarms.map((a) => (
          <AlarmRow
            key={a.id}
            alarm={a}
            acking={ack.isPending && ack.variables?.id === a.id}
            onAck={() => acknowledge(a.id)}
          />
        ))}
      </ul>
    </V6Card>
  );
}
