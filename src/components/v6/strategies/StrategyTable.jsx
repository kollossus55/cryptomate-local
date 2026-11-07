import React from "react";
import { Link } from "react-router-dom";
import { ChevronRight, CircleSlash, Eye, FileCheck2, FlaskConical, Microscope } from "lucide-react";
import { createPageUrl } from "@/components/utils";
import { ToneBadge } from "../shared";
import EntrySwitch from "./EntrySwitch";
import { canTrade, forwardCell, isFailed, stateBadge, testsLine } from "./strategyView";

export function StateBadge({ strategy }) {
  const { tone, label } = stateBadge(strategy);
  const icon = isFailed(strategy) ? CircleSlash
    : strategy.lifecycle === "shadow" ? Eye
      : strategy.lifecycle === "certified" ? FileCheck2
        : strategy.lifecycle === "research" ? Microscope : FlaskConical;
  return <ToneBadge tone={tone} icon={icon} className="whitespace-nowrap">{label}</ToneBadge>;
}

export const strategyUrl = (id) => `${createPageUrl("Strategies")}?id=${encodeURIComponent(id)}`;

function Stacked({ main, sub }) {
  return (
    <>
      <div className="text-slate-200">{main}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </>
  );
}

function EntriesCell({ strategy }) {
  if (canTrade(strategy) || strategy.lifecycle === "shadow") {
    return <EntrySwitch strategy={strategy} showLabel={false} />;
  }
  return <span className="text-xs text-slate-400">Cannot trade</span>;
}

export default function StrategyTable({ items }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead className="text-left text-xs text-slate-400">
          <tr>
            <th className="py-2 pr-4 font-medium">Strategy</th>
            <th className="py-2 pr-4 font-medium">State</th>
            <th className="py-2 pr-4 font-medium">Tests</th>
            <th className="py-2 pr-4 font-medium">Forward</th>
            <th className="py-2 pr-4 font-medium">Sleeve</th>
            <th className="py-2 pr-4 font-medium">Entries</th>
            <th><span className="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id} className="border-t border-slate-800 align-top">
              <td className="py-2.5 pr-4">
                <Link to={strategyUrl(s.id)} className="font-medium text-slate-100 hover:underline">
                  {s.name ?? s.id}
                </Link>
                <div className="text-xs text-slate-400">{s.id}, {s.timeframe ?? "-"}</div>
              </td>
              <td className="py-2.5 pr-4"><StateBadge strategy={s} /></td>
              <td className="py-2.5 pr-4"><Stacked {...testsLine(s)} /></td>
              <td className="py-2.5 pr-4"><Stacked {...forwardCell(s)} /></td>
              <td className="py-2.5 pr-4 text-slate-300">{s.sleevePct != null ? `${s.sleevePct}%` : canTrade(s) ? "Equal" : "-"}</td>
              <td className="py-2.5 pr-4"><EntriesCell strategy={s} /></td>
              <td className="py-2.5 text-right">
                <Link
                  to={strategyUrl(s.id)} aria-label={`Open ${s.name ?? s.id}`}
                  className="inline-block rounded p-1 text-slate-400 hover:text-white"
                >
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
