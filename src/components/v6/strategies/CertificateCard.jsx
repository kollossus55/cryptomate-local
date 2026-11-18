import React from "react";
import { AlertTriangle, FileCheck2, FileX2, FileQuestion } from "lucide-react";
import { ToneBadge, V6Card, utcDateYear } from "../shared";
import { holdoutUsed } from "./strategyView";

const STATUS = {
  valid: { tone: "emerald", icon: FileCheck2, label: "Valid" },
  failed: { tone: "slate", icon: FileX2, label: "Failed" },
  stale: { tone: "amber", icon: AlertTriangle, label: "Stale" },
};

const shortHash = (h) => (h && h.length > 10 ? `${h.slice(0, 4)}...${h.slice(-4)}` : h ?? "-");

function Line({ label, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-slate-800 py-1.5 first:border-t-0">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right text-slate-200">{children}</dd>
    </div>
  );
}

// Read only. Certificates come from the research validator, and the API has no
// write action for them, so nothing here can create or change one.
export default function CertificateCard({ certificate }) {
  const none = !certificate || certificate.status === "none";
  const used = holdoutUsed(certificate);
  const status = STATUS[certificate?.status] ?? { tone: "slate", icon: FileQuestion, label: "None" };
  return (
    <V6Card title="Certificate" actions={<ToneBadge tone={status.tone} icon={status.icon}>{status.label}</ToneBadge>}>
      {none ? (
        <p className="text-sm text-slate-400">Not tested yet.</p>
      ) : (
        <>
          <dl className="text-sm">
            <Line label="Issued">{utcDateYear(certificate.issuedAt)}</Line>
            <Line label="Hash">
              <span className="font-mono text-xs">{shortHash(certificate.hash)}</span>{" "}
              {certificate.hashMatches === true && <span className="text-slate-400">matches code</span>}
              {certificate.hashMatches === false && <span className="text-red-300">does not match code</span>}
            </Line>
            {certificate.expiresAt != null && <Line label="Expires">{utcDateYear(certificate.expiresAt)}</Line>}
            <Line label="Trial count (global)">{certificate.trialCount ?? "-"}</Line>
            <Line label="Holdout">
              {used && certificate.holdoutClean === true && "Clean"}
              {used && certificate.holdoutClean === false && <span className="text-amber-300">Not clean</span>}
              {(!used || certificate.holdoutClean == null) && "Not used"}
            </Line>
          </dl>
          {certificate.status === "valid" && (
            <p className="mt-2 text-xs text-slate-400">
              Passed its tests on past data, net of costs. Past results do not predict future ones.
            </p>
          )}
        </>
      )}
      <p className="mt-2 text-xs text-slate-500">
        Certificates come only from the research validator. This page cannot create or edit one.
      </p>
    </V6Card>
  );
}
