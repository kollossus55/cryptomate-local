import React from "react";
import { checkLabel } from "./signalView";

const PARTS = [
  ["total", "tested"],
  ["entered", "entered"],
  ["blocked", "blocked"],
  ["rejected", "rejected"],
  ["shadow", "shadow"],
  ["notTested", "not tested"],
];

export default function SignalSummary({ summary }) {
  if (!summary) return null;
  const top = summary.topFailure;
  return (
    <div className="space-y-1 text-sm text-slate-300">
      <p className="flex flex-wrap gap-x-2 gap-y-1">
        {PARTS.map(([key, label], i) => (
          <span key={key}>
            {i > 0 && <span className="mr-2 text-slate-600" aria-hidden="true">|</span>}
            <span className="font-semibold text-slate-100">{summary[key] ?? 0}</span> {label}
          </span>
        ))}
      </p>
      {top?.check && (
        <p className="text-xs text-slate-400">Most common block: {checkLabel(top.check)} ({top.count})</p>
      )}
    </div>
  );
}
