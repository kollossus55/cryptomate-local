import React from "react";
import { Banknote } from "lucide-react";
import { V6Card } from "../shared";

// Day one is a result, not a fault, so this stays slate and calm.
export default function NoCertifiedCard({ items }) {
  const tested = items.filter((s) => s.certificate && s.certificate.status !== "none").length;
  const passed = items.filter((s) => s.certificate?.status === "valid").length;
  const shadow = items.filter((s) => s.lifecycle === "shadow").length;
  return (
    <V6Card>
      <div className="flex items-start gap-3">
        <Banknote className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" aria-hidden="true" />
        <div className="space-y-2">
          <h2 className="font-semibold text-slate-100">
            {passed ? "No strategy is allowed to trade right now" : "No strategy has passed certification"}
          </h2>
          <p className="max-w-3xl text-sm text-slate-300">
            So nothing is allowed to open a new position. Any position already open still closes under
            its exit plan, then V6 sits in cash. This is an expected result, not a fault. V6 only trades
            strategies that pass fixed tests on past data, net of costs.
          </p>
          {items.length > 0 && (
            <p className="text-sm text-slate-400">
              {tested} {tested === 1 ? "candidate" : "candidates"} tested. {passed} passed.
              {shadow > 0 && ` ${shadow} running in shadow, logging only.`}
            </p>
          )}
        </div>
      </div>
    </V6Card>
  );
}
