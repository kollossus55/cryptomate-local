import React from "react";
import { ArrowRight, CornerDownRight } from "lucide-react";
import { isFailed } from "./strategyView";

const STEPS = [
  { id: "research", label: "Research" },
  { id: "certified", label: "Certified" },
  { id: "paper_half", label: "Paper (half risk)" },
  { id: "paper_full", label: "Paper (full risk)" },
];

function Step({ label, current, tone = "indigo" }) {
  const on = tone === "amber"
    ? "border-amber-500/60 bg-amber-500/15 font-semibold text-amber-200"
    : "border-indigo-500/60 bg-indigo-500/15 font-semibold text-indigo-200";
  return (
    <span
      aria-current={current ? "step" : undefined}
      className={`rounded border px-2 py-1 text-xs ${current ? on : "border-slate-700 text-slate-400"}`}
    >
      {current && <span className="sr-only">Current state: </span>}
      {label}
    </span>
  );
}

export default function LifecycleStepper({ strategy }) {
  const failed = isFailed(strategy);
  const shadow = strategy.lifecycle === "shadow";
  const until = strategy.halfRiskUntilTrades;
  const done = strategy.forwardTrades ?? 0;
  return (
    <div className="space-y-2">
      <ol className="flex flex-wrap items-center gap-2">
        {STEPS.map((step, i) => (
          <li key={step.id} className="flex items-center gap-2">
            {i > 0 && <ArrowRight className="h-3 w-3 text-slate-600" aria-hidden="true" />}
            <Step label={step.label} current={strategy.lifecycle === step.id} />
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <CornerDownRight className="h-3 w-3 text-slate-600" aria-hidden="true" />
        <Step label="Shadow, no positions" current={shadow} tone="amber" />
        <span>Automatic on a drift breach. Going back needs a human decision.</span>
      </div>
      {failed && <p className="text-xs text-slate-400">Stopped at research: it failed its tests.</p>}
      {strategy.lifecycle === "paper_half" && until > 0 && (
        <div className="max-w-md space-y-1">
          <p className="text-xs text-slate-400">
            Half risk until {until} forward trades complete: {done} of {until}.
          </p>
          <div
            role="progressbar" aria-valuemin={0} aria-valuemax={until} aria-valuenow={Math.min(done, until)}
            aria-label="Forward trades completed" className="h-1.5 overflow-hidden rounded-full bg-slate-800"
          >
            <div className="h-full rounded-full bg-slate-400" style={{ width: `${Math.min(100, (done / until) * 100)}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
