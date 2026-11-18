import React from "react";
import { XCircle } from "lucide-react";
import { V6Card } from "../shared";
import { criteriaByGroup, criterionResult, isFailed } from "./strategyView";

// The plain answer to "why is this not trading?", above the full evidence.
// Slate on purpose: a failed candidate is a useful result, not an alarm.
export default function WhyFailed({ strategy, certificate }) {
  const { failed } = criteriaByGroup(certificate?.criteria);
  const stale = certificate?.status === "stale";
  if (!stale && !isFailed(strategy) && !failed.length) return null;
  return (
    <V6Card title={stale ? "Why this certificate no longer applies" : "Why this strategy did not pass"}>
      <div className="space-y-3 text-sm">
        {stale && (
          <p className="text-slate-300">
            Either the code or parameters changed after this test, or the certificate expired. Test 1 of
            the signal gate blocks every entry until a new certificate exists.
          </p>
        )}
        {failed.length > 0 && (
          <ul className="space-y-2">
            {failed.map((row) => (
              <li key={row.id} className="flex items-start gap-2">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
                <span className="text-slate-300">
                  <span className="font-mono text-xs text-slate-400">{row.id}</span>{" "}
                  {row.label}: needs {row.needs ?? "-"}, got {criterionResult(row)}.
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-slate-400">
          It cannot open a paper position, and no control on this page can change that. Only a new
          version that passes every test can trade. A failure is a valid result: the rule is not
          retuned to make it pass.
        </p>
      </div>
    </V6Card>
  );
}
