// Position rows the engine cannot read. Such a row has no stop and never exits, so this is
// shown on both pages and never folded into the alarm list, where it could be acknowledged
// away. Rows arrive from status.quarantinedPositions and may hold anything, so only the
// symbol and the server's message are shown.
import React from 'react';
import { AlertOctagon } from 'lucide-react';

export default function QuarantineCard({ rows }) {
  if (!rows?.length) return null;
  const one = rows.length === 1;
  return (
    <section role="alert" className="space-y-2 rounded-xl border border-red-500/60 bg-red-500/10 p-4 text-sm">
      <h2 className="flex items-center gap-2 text-base font-semibold text-red-100">
        <AlertOctagon className="h-5 w-5 shrink-0" aria-hidden="true" />
        {one ? '1 position cannot be read and will never exit' : `${rows.length} positions cannot be read and will never exit`}
      </h2>
      <ul className="space-y-1">
        {rows.map((row, i) => (
          <li key={`${row.symbol ?? 'unknown'}-${i}`} className="text-slate-200">
            <span className="font-semibold text-slate-100">{row.symbol ?? 'Unknown coin'}</span>: {row.message}
          </li>
        ))}
      </ul>
      <p className="text-slate-300">
        No stop protects {one ? 'this position' : 'these positions'}, whatever the price does, and flatten cannot close{' '}
        {one ? 'it' : 'them'}. New entries stay blocked until a person repairs the row. There is no button for this: the repair is a
        manual edit with the server stopped (docs/rebuild/engine.md).
      </p>
    </section>
  );
}
