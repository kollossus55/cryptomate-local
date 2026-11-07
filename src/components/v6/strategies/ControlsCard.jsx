import React from "react";
import { V6Card } from "../shared";
import EntrySwitch from "./EntrySwitch";
import { canTrade } from "./strategyView";

const riskWord = (m) => (m === 0.5 ? " (half risk)" : m === 1 ? " (full risk)" : "");

function Fact({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-slate-800 py-1.5">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right text-slate-200">{children}</dd>
    </div>
  );
}

export default function ControlsCard({ strategy }) {
  const shadow = strategy.lifecycle === "shadow";
  const active = canTrade(strategy);
  return (
    <V6Card title="Controls">
      {active || shadow ? <EntrySwitch strategy={strategy} /> : (
        <p className="text-sm text-slate-300">Not certified, cannot trade.</p>
      )}
      <dl className="mt-3 text-sm">
        <Fact label="Capital sleeve (read only)">
          {strategy.sleevePct != null ? `${strategy.sleevePct}%` : active ? "Equal share" : "None"}
        </Fact>
        <Fact label="Size multiplier">
          {strategy.sizeMultiplier == null ? "-" : `${strategy.sizeMultiplier}${riskWord(strategy.sizeMultiplier)}`}
        </Fact>
      </dl>
      <p className="mt-2 text-xs text-slate-400">
        Sleeves are equal risk across active strategies. They are shown here and cannot be edited.
      </p>
      {active && (
        <p className="mt-1 text-xs text-slate-400">Off blocks entries only. Open positions keep their exit plans.</p>
      )}
      {shadow && <p className="mt-1 text-xs text-slate-400">Logging only. Shadow cannot create a position.</p>}
    </V6Card>
  );
}
