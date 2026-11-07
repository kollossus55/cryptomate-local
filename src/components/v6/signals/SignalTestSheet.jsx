import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { createPageUrl } from "@/components/utils";
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  CheckIcon, EmptyNote, InlineError, SkeletonRows, ToneBadge, coin, pct, useV6Query, utc,
} from "../shared";
import { CHECKS, blockedDetail, checkLabel, checkStatus, outcomeOf, whyLine } from "./signalView";

const STATUS_TEXT = { pass: "Passed", fail: "Failed", not_run: "Not run" };

// Check 1 reports its expiry as epoch ms.
const valueText = (v) => (v.label === "expires" && typeof v.value === "number" ? utc(v.value) : v.value ?? "-");

function Values({ values }) {
  if (!values?.length) return null;
  return (
    <table className="mt-1 w-full text-xs">
      <thead className="text-left text-slate-500">
        <tr>
          <th className="py-0.5 pr-2 font-medium">Measure</th>
          <th className="py-0.5 pr-2 font-medium">Value</th>
          <th className="py-0.5 font-medium">Threshold</th>
        </tr>
      </thead>
      <tbody>
        {values.map((v, i) => (
          <tr key={`${v.label}-${i}`} className="align-top text-slate-300">
            <td className="py-0.5 pr-2 text-slate-400">{v.label}</td>
            <td className="break-all py-0.5 pr-2">{valueText(v)}</td>
            <td className="py-0.5">{v.limit ?? "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CheckRow({ spec, check, outcome }) {
  const status = checkStatus(check?.status);
  const fallback = !check
    ? "No result stored."
    : outcome === "blocked" ? "Not run: blocked earlier." : "Not run.";
  return (
    <li className={`border-t border-slate-800 py-2 ${status === "fail" ? "bg-red-500/5" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-slate-200">{spec.n}. {check?.label ?? spec.label}</span>
        <span className="inline-flex items-center gap-1 text-xs text-slate-300">
          <CheckIcon status={status} /> {STATUS_TEXT[status]}
        </span>
      </div>
      <p className="text-xs text-slate-400">{check?.text ?? (status === "not_run" ? fallback : "")}</p>
      <Values values={check?.values} />
      {(check?.smallSample || /small sample/i.test(check?.text ?? "")) && (
        <p className="mt-1 text-xs text-amber-300">Small sample. The result stands as reported.</p>
      )}
    </li>
  );
}

function stopLine(test) {
  const parts = [];
  // The stored value is a fraction, as v6Core keeps it on the signal.
  if (test.stopDistancePct != null) {
    parts.push(`Stop ${pct(test.stopDistancePct * 100)} ${test.side === "short" ? "above" : "below"} entry.`);
  }
  if (test.exitProfile) parts.push(`Profile: ${test.exitProfile}.`);
  return parts.join(" ");
}

function Detail({ test }) {
  const o = outcomeOf(test.outcome);
  const blocked = test.outcome === "blocked";
  const checks = Array.isArray(test.checks) ? test.checks : [];
  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <ToneBadge tone={o.tone}>{o.label.toUpperCase()}</ToneBadge>
        {test.rankInBatch != null && test.batchSize != null && (
          <span className="text-xs text-slate-400">Ranked {test.rankInBatch} of {test.batchSize} today</span>
        )}
      </div>

      {test.reason && (
        <div>
          <h3 className="text-xs text-slate-400">Why it wanted to trade</h3>
          <p className="text-sm text-slate-200">{test.reason}</p>
        </div>
      )}

      <div className={`rounded border p-3 text-sm ${blocked ? "border-red-500/40 bg-red-500/10" : "border-slate-700"}`}>
        {blocked && test.blockedBy && (
          <p className="text-xs font-semibold uppercase tracking-wide text-red-300">
            Blocked by {checkLabel(test.blockedBy)}
          </p>
        )}
        <p className="text-slate-200">{blocked ? blockedDetail(test) ?? whyLine(test) : whyLine(test)}</p>
      </div>

      <ol>
        {CHECKS.map((spec) => (
          <CheckRow
            key={spec.id} spec={spec} outcome={test.outcome}
            check={checks.find((c) => c.id === spec.id)}
          />
        ))}
      </ol>

      {stopLine(test) && <p className="text-xs text-slate-400">{stopLine(test)}</p>}
      {test.tradeId && (
        <Link to={createPageUrl("TradeHistory")} className="inline-flex items-center gap-1 text-xs text-slate-300 hover:text-white">
          See the paper trade <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}

export default function SignalTestSheet({ id, onClose }) {
  const query = useV6Query(
    "signalTest", { id },
    { enabled: Boolean(id), placeholderData: undefined },
  );
  const test = query.data?.test;
  const notFound = query.error?.code === "NOT_FOUND";

  return (
    <Sheet open={Boolean(id)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto border-slate-800 bg-slate-900 text-slate-200 sm:max-w-md">
        <SheetHeader className="text-left">
          <SheetTitle className="pr-6 text-slate-100">
            {test ? `${coin(test.symbol)} ${test.side ?? ""}, ${test.strategyId}` : "Signal test"}
          </SheetTitle>
          <SheetDescription className="text-slate-400">
            {test
              ? `${utc(test.t)}${test.barTime != null ? `, decided on the bar of ${utc(test.barTime)}` : ""}`
              : "All seven tests for this signal."}
          </SheetDescription>
        </SheetHeader>

        {query.isPending && id && <div className="mt-4"><SkeletonRows rows={8} height="h-8" /></div>}
        {notFound && <EmptyNote>This test is no longer stored.</EmptyNote>}
        {query.isError && !notFound && !test && (
          <InlineError error={query.error} label="Could not load this test" onRetry={() => query.refetch()} />
        )}
        {test && <Detail test={test} />}
      </SheetContent>
    </Sheet>
  );
}
