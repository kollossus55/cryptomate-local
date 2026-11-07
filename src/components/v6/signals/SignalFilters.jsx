import React from "react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { coin } from "../shared";
import { CHECKS, OUTCOMES, RANGES, hasActiveFilters } from "./signalView";

// Radix Select refuses an empty item value, so "all" stands in for no filter.
const ALL = "__all";

function Filter({ label, value, onChange, allLabel, options }) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
      <SelectTrigger aria-label={label} className="h-9 w-full border-slate-700 bg-slate-900 text-slate-200 sm:w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allLabel && <SelectItem value={ALL}>{allLabel}</SelectItem>}
        {options.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export default function SignalFilters({ filters, facets, onChange, onClear }) {
  const strategies = (facets?.strategies ?? []).map((s) => ({ id: s.id, label: s.name ?? s.id }));
  const symbols = (facets?.symbols ?? []).map((s) => ({ id: s, label: coin(s) }));
  // A filter arriving by link must stay visible even if this page of facets lacks it.
  if (filters.strategy && !strategies.some((s) => s.id === filters.strategy)) {
    strategies.push({ id: filters.strategy, label: filters.strategy });
  }
  if (filters.symbol && !symbols.some((s) => s.id === filters.symbol)) {
    symbols.push({ id: filters.symbol, label: coin(filters.symbol) });
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Filter label="Time range" value={filters.range} onChange={(v) => onChange("range", v)} options={RANGES} />
      <Filter label="Strategy" value={filters.strategy} onChange={(v) => onChange("strategy", v)} allLabel="All strategies" options={strategies} />
      <Filter label="Coin" value={filters.symbol} onChange={(v) => onChange("symbol", v)} allLabel="All coins" options={symbols} />
      <Filter label="Outcome" value={filters.outcome} onChange={(v) => onChange("outcome", v)} allLabel="All outcomes" options={OUTCOMES} />
      <Filter label="Failed test" value={filters.failed} onChange={(v) => onChange("failed", v)} allLabel="Any failed test" options={CHECKS} />
      {hasActiveFilters(filters) && (
        <Button variant="ghost" size="sm" className="text-slate-300" onClick={onClear}>Clear</Button>
      )}
    </div>
  );
}
