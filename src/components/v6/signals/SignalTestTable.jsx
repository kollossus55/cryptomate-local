import React from "react";
import { ChevronRight } from "lucide-react";
import { CheckIcon, ToneBadge, coin, utc, utcDate, utcTime } from "../shared";
import { CHECKS, compactChecks, outcomeOf, statusFor, whyLine } from "./signalView";

const STATUS_TEXT = { pass: "passed", fail: "failed", not_run: "not run" };

function OutcomeBadge({ outcome }) {
  const o = outcomeOf(outcome);
  return <ToneBadge tone={o.tone} className="whitespace-nowrap">{o.label.toUpperCase()}</ToneBadge>;
}

function DesktopRow({ item, onOpen }) {
  return (
    <>
      <tr
        className="cursor-pointer border-t border-slate-800 hover:bg-slate-800/40"
        onClick={() => onOpen(item.id)}
      >
        <td className="whitespace-nowrap py-2 pr-3 text-slate-300">{utcDate(item.t)} {utcTime(item.t)}</td>
        <td className="py-2 pr-3 font-medium text-slate-100">{coin(item.symbol)}</td>
        <td className="py-2 pr-3 text-slate-300">{item.strategyId}</td>
        <td className="py-2 pr-3"><OutcomeBadge outcome={item.outcome} /></td>
        {CHECKS.map((c) => (
          <td key={c.id} className="px-1 py-2 text-center">
            <CheckIcon status={statusFor(item.checks, c.id)} label={`${c.label}: ${STATUS_TEXT[statusFor(item.checks, c.id)]}`} />
          </td>
        ))}
        <td className="py-2 pl-2 text-right">
          <button
            type="button"
            aria-label={`Open test details for ${item.symbol ?? "signal"}`}
            className="rounded p-1 text-slate-400 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
            onClick={(e) => { e.stopPropagation(); onOpen(item.id); }}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </td>
      </tr>
      {item.outcome !== "entered" && (
        <tr className="cursor-pointer" onClick={() => onOpen(item.id)}>
          <td colSpan={5 + CHECKS.length} className="pb-2 pl-1 text-xs text-slate-400">{whyLine(item)}</td>
        </tr>
      )}
    </>
  );
}

function PhoneRow({ item, onOpen }) {
  return (
    <li className="border-t border-slate-800">
      <button type="button" onClick={() => onOpen(item.id)} className="w-full space-y-1 py-3 text-left">
        <span className="flex items-center justify-between gap-2">
          <span className="font-medium text-slate-100">{coin(item.symbol)}</span>
          <OutcomeBadge outcome={item.outcome} />
        </span>
        <span className="block text-xs text-slate-400">{utc(item.t)}, {item.strategyId}</span>
        <span className="block text-xs text-slate-300">{compactChecks(item.checks)}</span>
        {item.outcome !== "entered" && <span className="block text-xs text-slate-400">{whyLine(item)}</span>}
      </button>
    </li>
  );
}

export default function SignalTestTable({ items, onOpen }) {
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-400">
            <tr>
              <th className="py-2 pr-3 font-medium">Time (UTC)</th>
              <th className="py-2 pr-3 font-medium">Coin</th>
              <th className="py-2 pr-3 font-medium">Strategy</th>
              <th className="py-2 pr-3 font-medium">Result</th>
              {CHECKS.map((c) => (
                <th key={c.id} className="px-1 py-2 text-center font-medium" title={c.label}>{c.short}</th>
              ))}
              <th><span className="sr-only">Details</span></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => <DesktopRow key={item.id} item={item} onOpen={onOpen} />)}
          </tbody>
        </table>
      </div>
      <ul className="md:hidden">
        {items.map((item) => <PhoneRow key={item.id} item={item} onOpen={onOpen} />)}
      </ul>
    </>
  );
}
