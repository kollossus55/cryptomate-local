import React, { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { ListChecks, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EmptyNote, InlineError, PageError, PageHeader, SkeletonRows, StaleSince, V6Card, describeV6Error,
} from "@/components/v6/shared";
import SignalFilters from "@/components/v6/signals/SignalFilters";
import SignalSummary from "@/components/v6/signals/SignalSummary";
import SignalTestSheet from "@/components/v6/signals/SignalTestSheet";
import SignalTestTable from "@/components/v6/signals/SignalTestTable";
import { useSignalTests } from "@/components/v6/signals/useSignalTests";
import {
  RANGES, filtersFromParams, hasActiveFilters, requestFromFilters,
} from "@/components/v6/signals/signalView";

const SUBTITLE = "Every entry must clear all 7 tests. Clearing them means the trade is allowed. It may still lose.";

const FILTER_KEYS = ["range", "strategy", "symbol", "outcome", "failed"];

function EmptyState({ filters, onClear }) {
  if (hasActiveFilters(filters)) {
    return (
      <div className="flex flex-wrap items-center gap-3 py-2">
        <EmptyNote>No tests match these filters.</EmptyNote>
        <Button variant="outline" size="sm" className="border-slate-700" onClick={onClear}>Clear</Button>
      </div>
    );
  }
  const range = RANGES.find((r) => r.id === filters.range)?.label.toLowerCase();
  return <EmptyNote>Nothing tested in the {range}. A test appears when a strategy produces a signal.</EmptyNote>;
}

export default function SignalTests() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const openId = params.get("id");

  // Date.now() is read once per filter change, so polling does not mint a new query key.
  const request = useMemo(() => requestFromFilters(filters, Date.now()), [filters]);
  const query = useSignalTests(request);

  const update = (mutate, opts) => {
    const next = new URLSearchParams(params);
    mutate(next);
    setParams(next, opts);
  };
  const setFilter = (key, value) => update((p) => (value ? p.set(key, value) : p.delete(key)), { replace: true });
  const clearFilters = () => update((p) => FILTER_KEYS.forEach((k) => p.delete(k)), { replace: true });
  const openTest = (id) => update((p) => p.set("id", id));
  const closeTest = () => update((p) => p.delete("id"), { replace: true });

  const pages = query.data?.pages ?? [];
  const first = pages[0];
  const items = pages.flatMap((p) => p.items ?? []);
  const fatal = query.isError && !query.data
    && !["refusal", "error"].includes(describeV6Error(query.error).kind);

  return (
    <div className="space-y-6 p-4 md:p-6">
      <PageHeader title="Signal Tests" icon={ListChecks} subtitle={SUBTITLE} />

      {fatal ? <PageError error={query.error} onRetry={() => query.refetch()} /> : (
        <>
          <SignalFilters filters={filters} facets={first?.facets} onChange={setFilter} onClear={clearFilters} />
          <SignalSummary summary={first?.summary} />

          <V6Card title="Tests" actions={<StaleSince query={query} />}>
            {query.isPending && <SkeletonRows rows={6} height="h-8" />}
            {query.isError && !query.data && (
              <InlineError error={query.error} label="Could not load signal tests" onRetry={() => query.refetch()} />
            )}
            {query.data && !items.length && <EmptyState filters={filters} onClear={clearFilters} />}
            {items.length > 0 && (
              <div className={`transition-opacity ${query.isPlaceholderData ? "opacity-60" : ""}`}>
                <SignalTestTable items={items} onOpen={openTest} />
                {query.hasNextPage && (
                  <div className="mt-3 flex justify-center">
                    <Button
                      variant="outline" size="sm" className="border-slate-700"
                      disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}
                    >
                      {query.isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                      Load more
                    </Button>
                  </div>
                )}
              </div>
            )}
          </V6Card>
        </>
      )}

      <SignalTestSheet id={openId} onClose={closeTest} />
    </div>
  );
}
