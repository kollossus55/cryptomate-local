// Stat tile, from StrategyLab's StatCard. Text stays in text colours; `valueCls` is for
// P&L only.
import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { StaleBadge } from './ToneBadge';

export default function StatTile({ label, value, valueCls = 'text-slate-100', sub, sub2, stale = false, loading = false }) {
  return (
    <Card className="border-slate-800 bg-slate-900/60">
      <CardContent className="space-y-1 p-4">
        <div className="flex items-center justify-between gap-2 text-sm text-slate-300">
          <span>{label}</span>
          {stale && <StaleBadge />}
        </div>
        {loading ? (
          <Skeleton className="h-8 w-28 bg-slate-800" />
        ) : (
          <>
            <div className={`text-2xl font-semibold ${valueCls}`}>{value}</div>
            {sub && <div className="text-sm text-slate-400">{sub}</div>}
            {sub2 && <div className="text-xs text-slate-400">{sub2}</div>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
