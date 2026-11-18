// Risk Controls: V6 limits, pause, flatten, and the halt and re-enable flow (gui-design 5.4).
import React from 'react';
import { ShieldAlert } from 'lucide-react';
import EventsLog from '@/components/v6/risk/EventsLog';
import HaltPanel from '@/components/v6/risk/HaltPanel';
import RecutoverPanel from '@/components/v6/risk/RecutoverPanel';
import RiskForm from '@/components/v6/risk/RiskForm';
import PageHeader from '@/components/v6/shared/PageHeader';
import QuarantineCard from '@/components/v6/shared/QuarantineCard';
import { InlineError, PageError, SkeletonRows, V6Card } from '@/components/v6/shared/StateCard';
import { useAllTimeDrawdown } from '@/components/v6/shared/useAllTimeDrawdown';
import { useV6Status } from '@/components/v6/shared/useV6';

function Controls({ query }) {
  const status = query.data;
  const allTime = useAllTimeDrawdown(status);
  const stale = status.engine?.stale === true || status.headline?.state === 'ENGINE_DOWN' || query.isError;
  return (
    <>
      {query.isError && <InlineError error={query.error} label="Could not refresh" onRetry={() => query.refetch()} />}
      <QuarantineCard rows={status.quarantinedPositions} />
      <RecutoverPanel status={status} />
      <HaltPanel status={status} allTime={allTime} stale={stale} />
      <RiskForm rung={status.risk?.rung} halted={status.risk?.halted} />
      <EventsLog />
    </>
  );
}

export default function RiskControls() {
  const status = useV6Status();
  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader
        title="Risk Controls"
        icon={ShieldAlert}
        subtitle="Limits for V6 only. The old Auto-Trading settings have no effect here. These limits cap how much can be lost and how fast. They do not make a strategy profitable, and a price gap can fill a stop well past them."
      />
      {status.isPending ? (
        <V6Card title="Current state">
          <SkeletonRows rows={3} />
        </V6Card>
      ) : status.data === undefined ? (
        // Without status the rung is unknown, so the loosening rule cannot be shown. Editing stays off.
        <PageError error={status.error} onRetry={() => status.refetch()} />
      ) : (
        <Controls query={status} />
      )}
    </div>
  );
}
