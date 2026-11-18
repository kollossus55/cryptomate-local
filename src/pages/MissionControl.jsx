// Mission Control: what is V6 doing, why, and does it need me? (gui-design 5.1)
import React from 'react';
import { Gauge } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import AlarmList from '@/components/v6/mission/AlarmList';
import DecisionsFeed from '@/components/v6/mission/DecisionsFeed';
import DrawdownLadder from '@/components/v6/mission/DrawdownLadder';
import EquityVsBtcChart from '@/components/v6/mission/EquityVsBtcChart';
import HeadlineCard from '@/components/v6/mission/HeadlineCard';
import MissionTiles from '@/components/v6/mission/MissionTiles';
import PositionsTable from '@/components/v6/mission/PositionsTable';
import PageHeader from '@/components/v6/shared/PageHeader';
import QuarantineCard from '@/components/v6/shared/QuarantineCard';
import { InlineError, PageError, SkeletonRows, V6Card } from '@/components/v6/shared/StateCard';
import StatTile from '@/components/v6/shared/StatTile';
import { useAllTimeDrawdown } from '@/components/v6/shared/useAllTimeDrawdown';
import { useV6Status } from '@/components/v6/shared/useV6';

function LoadingView() {
  return (
    <>
      <Skeleton className="h-24 w-full bg-slate-800" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {['Paper equity', 'Vs BTC hold', 'Drawdown from all-time high', 'Exposure'].map((label) => (
          <StatTile key={label} label={label} loading />
        ))}
      </div>
      <Skeleton className="h-72 w-full bg-slate-800" />
      <V6Card title="Drawdown ladder">
        <SkeletonRows rows={3} />
      </V6Card>
      <V6Card title="Open positions">
        <SkeletonRows rows={2} />
      </V6Card>
    </>
  );
}

function Dashboard({ query }) {
  const status = query.data;
  const allTime = useAllTimeDrawdown(status);
  // Numbers stay on screen when the engine or the API stops, but never look current.
  const stale = status.engine?.stale === true || status.headline?.state === 'ENGINE_DOWN' || query.isError;

  return (
    <>
      {query.isError && <InlineError error={query.error} label="Could not refresh" onRetry={() => query.refetch()} />}
      <QuarantineCard rows={status.quarantinedPositions} />
      <HeadlineCard status={status} stale={stale} />
      <AlarmList engine={status.engine} />
      <MissionTiles status={status} allTime={allTime} stale={stale} />
      <EquityVsBtcChart />
      <DrawdownLadder risk={status.risk} allTime={allTime} stale={stale} />
      <PositionsTable positions={status.positions} quarantined={status.quarantinedPositions?.length ?? 0} stale={stale} />
      <DecisionsFeed engineHasRun={!!status.engine?.lastTickAt} />
    </>
  );
}

export default function MissionControl() {
  const status = useV6Status();
  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader title="Mission Control" icon={Gauge} />
      {status.isPending ? (
        <LoadingView />
      ) : status.data === undefined ? (
        <PageError error={status.error} onRetry={() => status.refetch()} />
      ) : (
        <Dashboard query={status} />
      )}
    </div>
  );
}
