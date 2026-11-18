// Shared chart chrome: series colours, legend, tooltip and the "View as table" toggle.
// Colours are validated against #0f172a (gui-design 3) and carry identity only, never
// status. Text stays in text colours; the short stroke beside it carries the identity.
import React, { useState } from 'react';
import { Table2, LineChart as LineChartIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export const SERIES_COLORS = {
  paper: '#3987e5',
  btc: '#199e70',
  comparison: '#d95926',
  expectedMedian: '#94a3b8',
  expectedBand: '#64748b',
};

export const AXIS = {
  grid: '#334155',
  gridOpacity: 0.35,
  line: '#475569',
  tick: '#94a3b8',
};

function LineKey({ color, dash }) {
  return (
    <svg width="18" height="6" aria-hidden="true" className="shrink-0">
      <line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dash} />
    </svg>
  );
}

/** items: [{ label, color, dash }] */
export function ChartLegend({ items }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2">
          <LineKey color={item.color} dash={item.dash} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Recharts tooltip content. One readout for every series, value first.
 * `rows(payloadRow)` returns [{ label, value, color, dash }].
 */
export function ChartTooltip({ active, payload, title, rows }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-slate-400">{title(row)}</div>
      {rows(row).map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-slate-200">
          {r.color ? <LineKey color={r.color} dash={r.dash} /> : <span className="w-[18px]" />}
          <span className="font-medium">{r.value}</span>
          <span className="ml-auto pl-3 text-slate-400">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** table: { columns: [{ key, label }], rows: [{ id, ...cells }] } */
function ChartTable({ caption, columns, rows }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="text-left text-xs text-slate-400">
            {columns.map((c) => (
              <th key={c.key} scope="col" className="sticky top-0 bg-slate-900 px-2 py-1 font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-slate-800 text-slate-300">
              {columns.map((c) => (
                <td key={c.key} className="whitespace-nowrap px-2 py-1">
                  {row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Wraps a chart with its legend, footnote and table view. Children are the chart. */
export function ChartFrame({ legend, footnote, table, caption, dimmed = false, children }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className="space-y-3">
      {legend && <ChartLegend items={legend} />}
      {asTable ? (
        <ChartTable caption={caption} columns={table.columns} rows={table.rows} />
      ) : (
        // Refetch keeps the frame: dim the old render rather than flash a skeleton.
        <div className={`transition-opacity ${dimmed ? 'opacity-60' : ''}`} role="img" aria-label={caption}>
          {children}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-400">{footnote}</p>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-slate-300 hover:bg-slate-800 hover:text-white"
          onClick={() => setAsTable((v) => !v)}
        >
          {asTable ? (
            <LineChartIcon className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Table2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          )}
          {asTable ? 'View as chart' : 'View as table'}
        </Button>
      </div>
    </div>
  );
}
