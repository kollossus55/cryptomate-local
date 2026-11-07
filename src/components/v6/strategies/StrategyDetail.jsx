import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ChevronLeft } from "lucide-react";
import { createPageUrl } from "@/components/utils";
import {
  EmptyNote, InlineError, PageError, SkeletonRows, StaleSince, V6Card, coin, describeV6Error,
  money, pnlCls, price, qty, signedMoney, useV6Query, utc,
} from "../shared";
import CertificateCard from "./CertificateCard";
import ControlsCard from "./ControlsCard";
import DriftChart from "./DriftChart";
import EvidenceTable from "./EvidenceTable";
import LifecycleStepper from "./LifecycleStepper";
import ReturnFromShadow from "./ReturnFromShadow";
import { StateBadge } from "./StrategyTable";
import WhyFailed from "./WhyFailed";
import { canTrade, verifiedCertificate } from "./strategyView";

const backLink = (
  <Link to={createPageUrl("Strategies")} className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white">
    <ChevronLeft className="h-4 w-4" aria-hidden="true" /> All strategies
  </Link>
);

function Params({ params }) {
  const entries = Object.entries(params ?? {});
  if (!entries.length) return null;
  return (
    <p className="text-xs text-slate-400">
      Parameters: {entries.map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ")}
    </p>
  );
}

function RecentTrades({ trades }) {
  if (!trades?.length) return <EmptyNote>No paper trades yet.</EmptyNote>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-left text-xs text-slate-400">
          <tr>
            <th className="py-2 pr-4 font-medium">Time (UTC)</th>
            <th className="py-2 pr-4 font-medium">Coin</th>
            <th className="py-2 pr-4 font-medium">Action</th>
            <th className="py-2 pr-4 font-medium">Qty</th>
            <th className="py-2 pr-4 font-medium">Price</th>
            <th className="py-2 pr-4 font-medium">Paper P&amp;L</th>
            <th className="py-2 font-medium">Why</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={t.id ?? i} className="border-t border-slate-800 text-slate-300">
              <td className="whitespace-nowrap py-2 pr-4">{utc(Date.parse(t.timestamp))}</td>
              <td className="py-2 pr-4 font-medium text-slate-100">{coin(t.asset_symbol)}</td>
              <td className="py-2 pr-4">{t.trade_type ?? "-"}</td>
              <td className="py-2 pr-4">{qty(t.quantity)}</td>
              <td className="py-2 pr-4">{price(t.price)}</td>
              <td className={`py-2 pr-4 ${pnlCls(t.profit_loss)}`}>
                {t.profit_loss == null ? "-" : signedMoney(t.profit_loss, { decimals: 2 })}
              </td>
              <td className="py-2 text-xs text-slate-400">{t.exit_reason ?? t.ai_signal?.reasoning ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ForwardCard({ strategy, drift }) {
  const running = canTrade(strategy) || strategy.lifecycle === "shadow";
  return (
    <V6Card title="Forward result vs what the backtest expected">
      {running && drift ? <DriftChart drift={drift} /> : (
        <EmptyNote>Not run. Only a certified strategy has a forward record.</EmptyNote>
      )}
    </V6Card>
  );
}

export default function StrategyDetail({ id }) {
  // No carry-over from the last strategy: showing its evidence under this name would be false.
  const query = useV6Query("strategyDetail", { id }, { placeholderData: undefined });

  if (query.isPending) {
    return <div className="space-y-4">{backLink}<SkeletonRows rows={8} height="h-10" /></div>;
  }
  if (query.isError && !query.data) {
    const info = describeV6Error(query.error);
    if (query.error?.code === "NOT_FOUND") {
      return <div className="space-y-4">{backLink}<EmptyNote>This strategy no longer exists.</EmptyNote></div>;
    }
    return (
      <div className="space-y-4">
        {backLink}
        {info.kind === "refusal" || info.kind === "error"
          ? <InlineError error={query.error} label="Could not load this strategy" onRetry={() => query.refetch()} />
          : <PageError error={query.error} onRetry={() => query.refetch()} />}
      </div>
    );
  }

  const { strategy, drift, recentTrades } = query.data;
  const certificate = verifiedCertificate(strategy, query.data.certificate);
  const hasCertificate = certificate && certificate.status !== "none";

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        {backLink}
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold text-slate-100">{strategy.name ?? strategy.id}</h2>
          <StateBadge strategy={strategy} />
          <span className="text-sm text-slate-400">
            v{strategy.version ?? "-"}, {strategy.timeframe ?? "-"}, {strategy.id}
          </span>
          <StaleSince query={query} />
        </div>
        {strategy.ruleText && <p className="max-w-3xl text-sm text-slate-300">{strategy.ruleText}</p>}
        {strategy.universeText && <p className="text-xs text-slate-400">Universe: {strategy.universeText}</p>}
        <Params params={strategy.params} />
      </div>

      <LifecycleStepper strategy={strategy} />
      <WhyFailed strategy={strategy} certificate={certificate} />
      <ReturnFromShadow strategy={strategy} certificate={certificate} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ControlsCard strategy={strategy} />
        <CertificateCard certificate={certificate} />
      </div>

      {hasCertificate && <EvidenceTable certificate={certificate} />}
      <ForwardCard strategy={strategy} drift={drift} />

      <V6Card
        title="Recent paper trades"
        actions={(
          <Link
            to={`${createPageUrl("SignalTests")}?strategy=${encodeURIComponent(strategy.id)}`}
            className="inline-flex items-center gap-1 text-xs text-slate-300 hover:text-white"
          >
            Recent signal tests <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
      >
        <RecentTrades trades={recentTrades} />
      </V6Card>
    </div>
  );
}
