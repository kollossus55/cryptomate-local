// Paper equity vs BTC hold, both indexed to 100 at the start of the range, on one axis.
// Marks follow the dataviz skill: 2px lines, ringed active dots, a crosshair tooltip that
// reads every series, end labels only where they do not collide, and a table view.
import React, { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import { AXIS, ChartFrame, ChartTooltip, SERIES_COLORS } from '../shared/ChartFrame';
import SegmentedTabs from '../shared/SegmentedTabs';
import { QueryState, StaleSince, V6Card } from '../shared/StateCard';
import { useV6Query } from '../shared/useV6';
import { DASH, money, utc, utcDate, utcTime } from '../shared/format';
import { axisFor } from './chartAxis';

const RANGES = [
  { value: '7d', label: '7D' },
  { value: '30d', label: '30D' },
  { value: '90d', label: '90D' },
  { value: 'all', label: 'All' },
];
const DAY_MS = 86_400_000;
const CHART_HEIGHT = 288;
const SURFACE = '#0f172a';
const LABEL_MIN_GAP_PX = 16;

const LEGEND = [
  { label: 'V6 paper', color: SERIES_COLORS.paper },
  { label: 'BTC hold', color: SERIES_COLORS.btc, dash: '6 4' },
];

const index = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : DASH);

/** Tooltip and table share these rows, so the two views cannot disagree. */
const tooltipRows = (row) => [
  { label: 'V6 paper', value: index(row.equityIndex), color: LEGEND[0].color },
  { label: 'BTC hold', value: index(row.btcIndex), color: LEGEND[1].color, dash: LEGEND[1].dash },
  { label: 'Paper equity', value: money(row.equity) },
];

export function hasEnoughHistory(points) {
  if (!points || points.length < 2) return false;
  return points[points.length - 1].t - points[0].t >= DAY_MS;
}

function EndLabel({ x, y, index: i, lastIndex, text, show }) {
  if (!show || i !== lastIndex) return null;
  return (
    <text x={x + 8} y={y} dy={4} fontSize={11} fill="#cbd5e1">
      {text}
    </text>
  );
}

function Chart({ points, dimmed, downsampled }) {
  const axis = useMemo(() => axisFor(points), [points]);
  const last = points[points.length - 1];
  const lastIndex = points.length - 1;
  const spanDays = (last.t - points[0].t) / DAY_MS;
  const tick = (t) => (spanDays <= 2 ? utcTime(t) : utcDate(t));

  // When the lines end close together the labels would collide, so the legend and the
  // tooltip carry identity instead of nudging labels off their lines.
  const gapPx = (Math.abs((last.equityIndex ?? 0) - (last.btcIndex ?? 0)) / (axis.domain[1] - axis.domain[0])) * CHART_HEIGHT;
  const showLabels = Number.isFinite(last.equityIndex) && Number.isFinite(last.btcIndex) && gapPx >= LABEL_MIN_GAP_PX;

  const table = {
    columns: [
      { key: 'time', label: 'Time (UTC)' },
      { key: 'paper', label: 'V6 paper' },
      { key: 'btc', label: 'BTC hold' },
      { key: 'equity', label: 'Paper equity' },
    ],
    rows: [...points].reverse().map((p) => ({
      id: p.t,
      time: utc(p.t),
      paper: index(p.equityIndex),
      btc: index(p.btcIndex),
      equity: money(p.equity),
    })),
  };

  const footnote = `Flat stretches are time in cash. BTC hold has no fees.${
    downsampled ? ' Thinned for display.' : ''
  }`;

  return (
    <ChartFrame
      legend={LEGEND}
      table={table}
      dimmed={dimmed}
      footnote={footnote}
      caption={`Paper equity and BTC hold, indexed to 100. Latest: V6 paper ${index(last.equityIndex)}, BTC hold ${index(last.btcIndex)}.`}
    >
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <LineChart data={points} margin={{ top: 8, right: showLabels ? 72 : 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={AXIS.grid} strokeOpacity={AXIS.gridOpacity} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tickFormatter={tick}
            stroke={AXIS.line}
            tick={{ fill: AXIS.tick, fontSize: 11 }}
            minTickGap={48}
          />
          <YAxis domain={axis.domain} ticks={axis.ticks} stroke={AXIS.line} tick={{ fill: AXIS.tick, fontSize: 11 }} width={40} />
          <ReferenceLine y={100} stroke={AXIS.line} />
          <Tooltip
            cursor={{ stroke: AXIS.line }}
            content={<ChartTooltip title={(row) => utc(row.t)} rows={tooltipRows} />}
          />
          <Line
            dataKey="btcIndex"
            name="BTC hold"
            stroke={SERIES_COLORS.btc}
            strokeWidth={2}
            strokeDasharray="6 4"
            strokeLinecap="round"
            dot={false}
            activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
            isAnimationActive={false}
            label={<EndLabel lastIndex={lastIndex} show={showLabels} text={`BTC ${index(last.btcIndex)}`} />}
          />
          <Line
            dataKey="equityIndex"
            name="V6 paper"
            stroke={SERIES_COLORS.paper}
            strokeWidth={2}
            strokeLinecap="round"
            dot={false}
            activeDot={{ r: 4, stroke: SURFACE, strokeWidth: 2 }}
            isAnimationActive={false}
            label={<EndLabel lastIndex={lastIndex} show={showLabels} text={`V6 ${index(last.equityIndex)}`} />}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export default function EquityVsBtcChart() {
  const [range, setRange] = useState('all');
  const curve = useV6Query('equityCurve', { range });

  return (
    <V6Card
      title="Paper equity vs BTC, both start at 100"
      actions={
        <div className="flex items-center gap-2">
          <StaleSince query={curve} />
          <SegmentedTabs value={range} onChange={setRange} options={RANGES} label="Chart range" />
        </div>
      }
    >
      <QueryState
        query={curve}
        errorLabel="Could not load chart"
        skeleton={<Skeleton className="h-72 w-full bg-slate-800" />}
        isEmpty={(d) => !hasEnoughHistory(d.points)}
        empty="The chart starts after the engine has run for a day."
      >
        {(data) => <Chart points={data.points} downsampled={data.downsampled} dimmed={curve.isPlaceholderData} />}
      </QueryState>
    </V6Card>
  );
}
