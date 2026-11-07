import React from "react";
import { useSearchParams } from "react-router-dom";
import { Layers } from "lucide-react";
import {
  EmptyNote, InlineError, PageError, PageHeader, SkeletonRows, StaleSince, V6Card,
  describeV6Error, useV6Query,
} from "@/components/v6/shared";
import NoCertifiedCard from "@/components/v6/strategies/NoCertifiedCard";
import StrategyDetail from "@/components/v6/strategies/StrategyDetail";
import StrategyTable from "@/components/v6/strategies/StrategyTable";
import { canTrade, sortStrategies, summaryCounts } from "@/components/v6/strategies/strategyView";

const SUBTITLE = "A strategy can only trade after passing fixed tests on past data, net of costs. "
  + "Passing does not predict future results. You cannot promote one by hand.";

function SummaryLine({ items, trialCount }) {
  const c = summaryCounts(items);
  const parts = [
    `${c.paper} paper`, `${c.certified} certified`, `${c.shadow} shadow`, `${c.failed} failed`,
    `${c.untested} not tested`,
  ];
  if (trialCount != null) parts.push(`Tested ${trialCount} parameter sets across all research`);
  return <p className="text-sm text-slate-300">{parts.join(" | ")}</p>;
}

function StrategyList() {
  const query = useV6Query("strategies");

  if (query.isPending) return <V6Card title="All strategies"><SkeletonRows rows={5} height="h-10" /></V6Card>;
  if (query.isError && !query.data) {
    const { kind } = describeV6Error(query.error);
    if (kind === "refusal" || kind === "error") {
      return (
        <V6Card title="All strategies">
          <InlineError error={query.error} label="Could not load strategies" onRetry={() => query.refetch()} />
        </V6Card>
      );
    }
    return <PageError error={query.error} onRetry={() => query.refetch()} />;
  }

  const items = sortStrategies(query.data.items ?? []);
  const anyActive = items.some(canTrade);
  return (
    <>
      {!anyActive && <NoCertifiedCard items={items} />}
      {items.length > 0 && <SummaryLine items={items} trialCount={query.data.globalTrialCount} />}
      <V6Card title="All strategies" actions={<StaleSince query={query} />}>
        {items.length
          ? <StrategyTable items={items} />
          : <EmptyNote>No strategies registered yet. Research results appear here when candidates are tested.</EmptyNote>}
      </V6Card>
    </>
  );
}

export default function Strategies() {
  const [params] = useSearchParams();
  const id = params.get("id");
  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader title="Strategies" icon={Layers} subtitle={SUBTITLE} />
      {id ? <StrategyDetail key={id} id={id} /> : <StrategyList />}
    </div>
  );
}
