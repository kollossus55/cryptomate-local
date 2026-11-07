// One wrapper for the loading, error, empty and stale branches (gui-design 9.2), so no V6
// card can fall through to a blank or to a default that hides a failure.
import React from 'react';
import { AlertCircle, RefreshCw, PackageOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { describeV6Error } from './useV6';
import { StaleBadge } from './ToneBadge';
import { utcTime } from './format';

export function V6Card({ title, actions, children, className = '', contentClassName = '' }) {
  return (
    <Card className={`border-slate-800 bg-slate-900/60 ${className}`}>
      {(title || actions) && (
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {title && <CardTitle className="text-base text-slate-200">{title}</CardTitle>}
            {actions}
          </div>
        </CardHeader>
      )}
      <CardContent className={`${title || actions ? '' : 'pt-6'} ${contentClassName}`}>{children}</CardContent>
    </Card>
  );
}

export function SkeletonRows({ rows = 3, height = 'h-6' }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`${height} w-full bg-slate-800`} />
      ))}
    </div>
  );
}

export function EmptyNote({ children }) {
  return <p className="py-4 text-sm text-slate-400">{children}</p>;
}

/** Small error for inside a card. */
export function InlineError({ error, label, onRetry }) {
  const info = describeV6Error(error);
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 py-3 text-sm text-red-300">
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {label ?? info.title}. <span className="text-slate-400">{info.message}</span>
      </span>
      {onRetry && (
        <Button size="sm" variant="outline" className="border-slate-700" onClick={onRetry}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" /> Retry
        </Button>
      )}
    </div>
  );
}

/**
 * Full-page state for when the API itself is missing or unreachable (gui-design 9.3).
 * "Not installed" is an install step rather than a fault, so it stays slate.
 */
export function PageError({ error, onRetry }) {
  const info = describeV6Error(error);
  const calm = info.kind === 'not_installed';
  const Icon = calm ? PackageOpen : AlertCircle;
  return (
    <Card className={calm ? 'border-slate-700 bg-slate-900/60' : 'border-red-500/50 bg-red-500/10'}>
      <CardContent className="flex flex-wrap items-start gap-3 p-6" role={calm ? undefined : 'alert'}>
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${calm ? 'text-slate-300' : 'text-red-300'}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-100">{info.title}</p>
          <p className="mt-1 text-sm text-slate-300">{info.message}</p>
        </div>
        {onRetry && (
          <Button size="sm" variant="outline" className="border-slate-700" onClick={onRetry}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" /> Retry
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Badge for a card whose last refetch failed while older data is still on screen. */
export function StaleSince({ query }) {
  if (!query.isError || query.data === undefined) return null;
  return <StaleBadge label={`stale since ${utcTime(query.dataUpdatedAt)} UTC`} />;
}

/**
 * Applies the query-state order: pending -> skeleton; error without data -> error;
 * empty -> empty; otherwise children(data).
 *
 *   <QueryState query={q} isEmpty={(d) => !d.items.length} empty="Nothing yet.">
 *     {(data) => <Table rows={data.items} />}
 *   </QueryState>
 */
export function QueryState({ query, skeleton, errorLabel, isEmpty, empty, children }) {
  if (query.isPending) return skeleton ?? <SkeletonRows />;
  if (query.isError && query.data === undefined) {
    return <InlineError error={query.error} label={errorLabel} onRetry={() => query.refetch()} />;
  }
  if (isEmpty?.(query.data)) return typeof empty === 'string' ? <EmptyNote>{empty}</EmptyNote> : empty;
  return children(query.data);
}
