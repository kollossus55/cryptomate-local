import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, Network } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import {
  EmptyNote, NEXT_TICK_NOTE, PageError, PageHeader, QueryState, SkeletonRows, StaleSince, V6Card,
  describeV6Error, useV6Mutation, useV6Query,
} from '@/components/v6/shared';
import ApiKeysNotice from '@/components/v6/exchanges/ApiKeysNotice';
import ConsensusTable from '@/components/v6/exchanges/ConsensusTable';
import VenueRoles from '@/components/v6/exchanges/VenueRoles';
import VenueTable from '@/components/v6/exchanges/VenueTable';
import {
  TEST_COOLDOWN_MS, disableImpact, displayHealth, draftFrom, enabledVenues, healthSummary, isDirty,
  moveVenue, rolesNotKept, saveProblems, setRole, setVenueEnabled, toPayload,
} from '@/components/v6/exchanges/venueDraft';

const PAGE_LEVEL_FAULTS = ['not_installed', 'server_down', 'load_failed'];

function HealthLine({ venues, minForConsensus }) {
  const { enabled, answering, unknown } = healthSummary(venues);
  const short = answering < minForConsensus;
  const Icon = short ? (unknown > 0 ? HelpCircle : AlertTriangle) : CheckCircle2;
  const cls = !short ? 'text-emerald-300' : unknown > 0 ? 'text-slate-300' : 'text-amber-300';
  return (
    <p className={`flex items-center gap-2 text-sm ${cls}`}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {answering} of {enabled} enabled venues answering.
      {unknown > 0 && ` ${unknown} not tried yet.`} Price checks need at least {minForConsensus}.
    </p>
  );
}

function VenuesCard({ data, query }) {
  const { toast } = useToast();
  const [staged, setStaged] = useState(null); // null until the first edit, so polls show through
  const [pendingDisable, setPendingDisable] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [testing, setTesting] = useState({});
  const [coolingDown, setCoolingDown] = useState({});
  const [results, setResults] = useState({});
  const timers = useRef([]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const save = useV6Mutation('setExchanges', { invalidates: ['exchanges', 'status'] });
  const test = useV6Mutation('testExchange', { invalidates: ['exchanges'] });

  const draft = staged ?? draftFrom(data);
  const dirty = isDirty(draft, data);
  const byId = Object.fromEntries(data.venues.map((v) => [v.venue, v]));
  const labelOf = (id) => byId[id]?.label ?? id;
  const context = { minForConsensus: data.minForConsensus, labelOf };
  const rows = draft.venues.map((v) => ({ ...byId[v.venue], enabled: v.enabled }));
  const problems = saveProblems(draft, context);
  const noReadings = rows.every((v) => displayHealth(v) === 'unknown' || displayHealth(v) === 'disabled');

  const edit = (next) => {
    setSaveError(null);
    setStaged(next);
  };

  const onToggle = (venue, on) => {
    if (on) return edit(setVenueEnabled(draft, venue, true));
    const impact = disableImpact(draft, venue, context);
    if (impact.blocked) {
      toast({ title: 'Venue stays on', description: impact.blocked });
      return undefined;
    }
    setPendingDisable({ venue, warnings: impact.warnings });
    return undefined;
  };

  const onTest = async (venue) => {
    setTesting((s) => ({ ...s, [venue]: true }));
    setCoolingDown((s) => ({ ...s, [venue]: true }));
    timers.current.push(setTimeout(
      () => setCoolingDown((s) => ({ ...s, [venue]: false })),
      TEST_COOLDOWN_MS,
    ));
    try {
      const { result } = await test.mutateAsync({ venue });
      setResults((r) => ({ ...r, [venue]: { result } }));
    } catch (err) {
      setResults((r) => ({ ...r, [venue]: { error: describeV6Error(err).message } }));
    } finally {
      setTesting((s) => ({ ...s, [venue]: false }));
    }
  };

  const onSave = async () => {
    setSaveError(null);
    try {
      const res = await save.mutateAsync(toPayload(draft, data.version));
      const fresh = await query.refetch();
      setStaged(null);
      const lost = fresh.data ? rolesNotKept(draft.roles, fresh.data.roles) : [];
      if (lost.length) {
        const using = lost.map((r) => `${r}: ${labelOf(fresh.data.roles?.[r]) ?? 'none'}`).join(', ');
        toast({
          title: 'Venues saved, role choice not kept',
          description: `The engine chose its own venue for this role. Now using ${using}.`,
        });
        return;
      }
      toast({ title: 'Saved', description: [NEXT_TICK_NOTE, ...(res.warnings ?? [])].join(' ') });
    } catch (err) {
      setSaveError(err.code === 'VERSION_CONFLICT'
        ? 'These settings changed elsewhere. Reload to see the latest.'
        : describeV6Error(err).message);
    }
  };

  return (
    <>
      <V6Card title="Venues" actions={<StaleSince query={query} />}>
        <div className="space-y-3">
          <HealthLine venues={rows} minForConsensus={data.minForConsensus} />
          {noReadings && <EmptyNote>Waiting for the first engine run.</EmptyNote>}
          <VenueTable
            rows={rows} draft={draft} testing={testing} coolingDown={coolingDown} results={results}
            onMove={(venue, delta) => edit(moveVenue(draft, venue, delta))}
            onToggle={onToggle} onTest={onTest}
          />
          {problems.map((p) => (
            <p key={p} className="flex items-center gap-2 text-sm text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" /> {p}
            </p>
          ))}
          {saveError && <p role="alert" className="text-sm text-red-300">{saveError}</p>}
          {dirty && (
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" className="border-slate-700" onClick={() => edit(null)}>
                {saveError ? 'Reload' : 'Discard'}
              </Button>
              <Button disabled={problems.length > 0 || save.isPending} onClick={onSave}>
                {save.isPending ? 'Saving...' : 'Save changes'}
              </Button>
            </div>
          )}
        </div>
      </V6Card>

      <VenueRoles
        draft={draft} minForConsensus={data.minForConsensus} labelOf={labelOf}
        onRole={(role, venue) => edit(setRole(draft, role, venue))}
      />

      <AlertDialog open={Boolean(pendingDisable)} onOpenChange={(open) => !open && setPendingDisable(null)}>
        <AlertDialogContent className="border-slate-700 bg-slate-900 text-slate-200">
          <AlertDialogHeader>
            <AlertDialogTitle>Switch off {labelOf(pendingDisable?.venue)}?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 text-slate-400">
              <span className="block">
                V6 stops using it for bars, prices and the order book. Nothing changes until you save.
              </span>
              {pendingDisable?.warnings.map((w) => <span key={w} className="block text-amber-300">{w}</span>)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-slate-700 bg-transparent">Keep it on</AlertDialogCancel>
            <AlertDialogAction onClick={() => edit(setVenueEnabled(draft, pendingDisable.venue, false))}>
              Switch off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function Exchanges() {
  const venues = useV6Query('exchanges');
  const consensus = useV6Query('consensus', undefined, { refetchInterval: 60_000 });

  const fault = venues.isError && venues.data === undefined ? describeV6Error(venues.error) : null;
  const shownVenues = venues.data ? enabledVenues(draftFrom(venues.data)) : [];
  const labelOf = (id) => venues.data?.venues.find((v) => v.venue === id)?.label ?? id;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader
        title="Exchanges"
        icon={Network}
        subtitle="Where V6 gets prices. Public data only: no API keys, no orders, no account access."
      />

      {fault && PAGE_LEVEL_FAULTS.includes(fault.kind) ? (
        <PageError error={venues.error} onRetry={() => venues.refetch()} />
      ) : (
        <>
          <QueryState
            query={venues}
            skeleton={<V6Card title="Venues"><SkeletonRows rows={8} /></V6Card>}
            errorLabel="Could not load venues"
          >
            {(data) => <VenuesCard data={data} query={venues} />}
          </QueryState>
          <ConsensusTable query={consensus} venues={shownVenues} labelOf={labelOf} />
        </>
      )}

      <ApiKeysNotice />
    </div>
  );
}
