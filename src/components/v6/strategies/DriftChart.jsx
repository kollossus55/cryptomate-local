import React, { useMemo } from "react";
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { AlertTriangle } from "lucide-react";
import { AXIS, ChartFrame, ChartTooltip, SERIES_COLORS, signedPct } from "../shared";
import { driftLine, mergeDriftRows } from "./strategyView";

const FORWARD = SERIES_COLORS.paper;
const MEDIAN = SERIES_COLORS.expectedMedian;
const BAND = SERIES_COLORS.expectedBand;
// Status colour, not a series: a breach always ships with an icon and a text label.
const BREACH = "#f87171";
const SURFACE = "#0f172a";

// Neutral like the band. Its own dash keeps it apart from the median without colour.
const LIMIT = "#64748b";
const LIMIT_DASH = "1 4";

const LEGEND = [
  { label: "Forward result", color: FORWARD },
  { label: "Expected median", color: MEDIAN, dash: "3 3" },
  { label: "Expected range, 5th to 95th percentile", color: BAND },
];
const LIMIT_LEGEND = { label: "Demotion limits", color: LIMIT, dash: LIMIT_DASH };

const tooltipRows = (row) => [
  row.returnPct != null && { label: "Forward", value: signedPct(row.returnPct), color: FORWARD },
  row.p95 != null && { label: "95th percentile", value: signedPct(row.p95) },
  row.p50 != null && { label: "Expected median", value: signedPct(row.p50), color: MEDIAN, dash: "3 3" },
  row.p5 != null && { label: "5th percentile", value: signedPct(row.p5) },
  row.hi != null && { label: "Upper demotion limit", value: signedPct(row.hi) },
  row.lo != null && { label: "Lower demotion limit", value: signedPct(row.lo) },
  row.breach && { label: "Drift breach", value: row.breach },
].filter(Boolean);

// Selective direct labels: the last point of a line only, in text ink.
function EndLabel({ index, lastIndex, x, y, value, text, dy = 4 }) {
  if (index !== lastIndex || value == null) return null;
  return <text x={x + 6} y={y + dy} fill="#cbd5e1" fontSize={11}>{text}</text>;
}

export default function DriftChart({ drift }) {
  const rows = useMemo(() => mergeDriftRows(drift), [drift]);
  const days = drift?.xUnit === "days";
  const xName = days ? "Days" : "Trades completed";
  const forwardCount = drift?.forward?.length ?? 0;
  const summary = driftLine({ status: drift?.status, n: drift?.n, note: drift?.note, xUnit: drift?.xUnit });

  if (forwardCount < 2) {
    return (
      <div className="space-y-1 py-2 text-sm text-slate-400">
        <p>The chart starts after the first forward {days ? "day" : "trade"} closes.</p>
        {forwardCount > 0 && <p className="text-xs">{summary.text}</p>}
      </div>
    );
  }

  const lastIndexOf = (key) => rows.reduce((last, r, i) => (r[key] != null ? i : last), -1);
  const lastForward = lastIndexOf("returnPct");
  const lastMedian = lastIndexOf("p50");
  const hasLimits = rows.some((r) => r.lo != null && r.hi != null);
  const lastExpectedX = rows[lastMedian]?.x;
  const pastBand = lastMedian >= 0 && lastForward > lastMedian;
  const breaches = (drift.breaches ?? [])
    .map((b) => ({ ...b, y: rows.find((r) => r.x === b.x)?.returnPct }))
    .filter((b) => b.y != null);

  const table = {
    columns: [
      { key: "x", label: xName }, { key: "forward", label: "Forward" }, { key: "p5", label: "5th pct" },
      { key: "p50", label: "Median" }, { key: "p95", label: "95th pct" },
      ...(hasLimits ? [{ key: "lo", label: "Lower limit" }, { key: "hi", label: "Upper limit" }] : []),
      { key: "note", label: "Note" },
    ],
    rows: rows.map((r) => ({
      id: r.x, x: r.x, forward: signedPct(r.returnPct), p5: signedPct(r.p5),
      p50: signedPct(r.p50), p95: signedPct(r.p95), lo: signedPct(r.lo), hi: signedPct(r.hi), note: r.breach ?? "",
    })),
  };

  const footnote = (
    <span className={summary.tone === "red" ? "text-red-300" : undefined}>
      {summary.tone === "red" && <AlertTriangle className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />}
      {summary.text}
      {hasLimits && (
        <span className="block text-slate-400">
          Leaving the shaded range alone is not a breach. The monitor looks after every {days ? "day" : "trade"}, so
          demotion uses wider limits.
        </span>
      )}
      {pastBand && (
        <span className="block text-slate-400">
          Past {lastExpectedX} the monitor compares the latest {lastExpectedX} with the end of the range, which this
          chart does not show.
        </span>
      )}
      {breaches.map((b) => (
        <span key={b.x} className="block text-slate-400">
          Breach at {days ? "day" : "trade"} {b.x}{b.note ? `: ${b.note}` : ""}
        </span>
      ))}
    </span>
  );

  return (
    <ChartFrame
      legend={hasLimits ? [...LEGEND, LIMIT_LEGEND] : LEGEND}
      table={table}
      footnote={footnote}
      caption={`Cumulative net return against ${xName.toLowerCase()}. ${summary.text}`}
    >
      <div className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 16, right: 64, bottom: 18, left: 0 }}>
            <CartesianGrid stroke={AXIS.grid} strokeOpacity={AXIS.gridOpacity} vertical={false} />
            <XAxis
              dataKey="x" type="number" domain={["dataMin", "dataMax"]} allowDecimals={false}
              stroke={AXIS.line} tick={{ fill: AXIS.tick, fontSize: 11 }} tickLine={false}
              label={{ value: xName, position: "insideBottom", offset: -10, fill: AXIS.tick, fontSize: 11 }}
            />
            <YAxis
              stroke={AXIS.line} tick={{ fill: AXIS.tick, fontSize: 11 }} tickLine={false} width={48}
              tickFormatter={(v) => `${v > 0 ? "+" : ""}${Math.round(v * 10) / 10}%`}
            />
            <ReferenceLine y={0} stroke={AXIS.line} />
            <Tooltip
              cursor={{ stroke: "#64748b", strokeWidth: 1 }}
              content={<ChartTooltip title={(row) => `${xName}: ${row.x}`} rows={tooltipRows} />}
            />
            <Area
              dataKey="band" stroke="none" fill={BAND} fillOpacity={0.25} connectNulls
              isAnimationActive={false} activeDot={false}
            />
            {hasLimits && ["lo", "hi"].map((key) => (
              <Line
                key={key} dataKey={key} stroke={LIMIT} strokeWidth={1} strokeDasharray={LIMIT_DASH} dot={false}
                connectNulls isAnimationActive={false} activeDot={false}
              />
            ))}
            <Line
              dataKey="p50" stroke={MEDIAN} strokeWidth={2} strokeDasharray="3 3" dot={false} connectNulls
              isAnimationActive={false} activeDot={false}
              label={<EndLabel lastIndex={lastMedian} text="Expected" />}
            />
            <Line
              dataKey="returnPct" stroke={FORWARD} strokeWidth={2} dot={false} connectNulls
              isAnimationActive={false}
              activeDot={{ r: 4, fill: FORWARD, stroke: SURFACE, strokeWidth: 2 }}
              label={<EndLabel lastIndex={lastForward} text="Forward" dy={lastForward === lastMedian ? -10 : 4} />}
            />
            {breaches.map((b) => (
              <ReferenceDot
                key={b.x} x={b.x} y={b.y} r={5} fill={BREACH} stroke={SURFACE} strokeWidth={2}
                label={{ value: "Drift breach", position: "top", fill: "#fca5a5", fontSize: 11 }}
              />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartFrame>
  );
}
