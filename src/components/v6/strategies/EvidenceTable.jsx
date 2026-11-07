import React from "react";
import { AlertTriangle } from "lucide-react";
import { CheckIcon, V6Card } from "../shared";
import { criteriaByGroup, criterionResult, criterionStatus } from "./strategyView";

const OUTCOME_TEXT = { pass: "Passed", fail: "Failed", not_run: "Not run" };

function Outcome({ status }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-300">
      <CheckIcon status={status} /> {OUTCOME_TEXT[status]}
    </span>
  );
}

function Rows({ rows }) {
  return rows.map((row) => {
    const status = criterionStatus(row.status);
    return (
      <tr key={row.id} className={`border-t border-slate-800 ${status === "fail" ? "bg-red-500/5" : ""}`}>
        <td className="py-2 pr-3 font-mono text-xs text-slate-400">{row.id}</td>
        <td className="py-2 pr-3 text-slate-200">{row.label}</td>
        <td className="py-2 pr-3 text-slate-400">{row.needs ?? "-"}</td>
        <td className={`py-2 pr-3 ${status === "fail" ? "text-red-300" : "text-slate-200"}`}>
          {status === "not_run" ? "-" : criterionResult(row)}
        </td>
        <td className="py-2"><Outcome status={status} /></td>
      </tr>
    );
  });
}

function Group({ title, note, rows, emptyText }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-slate-300">{title}</h3>
      {note}
      {rows.length ? (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-left text-xs text-slate-400">
              <tr>
                <th className="py-1 pr-3 font-medium">Test</th>
                <th className="py-1 pr-3 font-medium">What it checks</th>
                <th className="py-1 pr-3 font-medium">Needs</th>
                <th className="py-1 pr-3 font-medium">Result</th>
                <th className="py-1 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody><Rows rows={rows} /></tbody>
          </table>
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-400">{emptyText}</p>
      )}
    </div>
  );
}

export default function EvidenceTable({ certificate }) {
  const { dev, holdout } = criteriaByGroup(certificate?.criteria);
  const holdoutUsed = holdout.some((r) => criterionStatus(r.status) !== "not_run");
  return (
    <V6Card title="Evidence">
      <div className="space-y-6">
        <Group
          title="DEV: walk-forward, net of costs"
          rows={dev}
          emptyText="No DEV results stored on this certificate."
        />
        <Group
          title="HOLDOUT: one shot, frozen parameters"
          rows={holdout}
          emptyText="Not run. No holdout results are stored on this certificate."
          note={(
            <>
              {holdoutUsed && certificate?.holdoutClean === false && (
                <p className="mt-1 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Earlier research already looked at this period, so this holdout result is not a clean test.
                </p>
              )}
              {!holdoutUsed && holdout.length > 0 && (
                <p className="mt-1 text-xs text-slate-500">
                  Holdout not used. It is only spent on a candidate that passes every DEV test.
                </p>
              )}
            </>
          )}
        />
      </div>
    </V6Card>
  );
}
