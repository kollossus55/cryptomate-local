// Small segmented control for chart ranges and list filters.
import React from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** options: [{ value, label }] */
export default function SegmentedTabs({ value, onChange, options, label }) {
  return (
    <Tabs value={value} onValueChange={onChange}>
      <TabsList aria-label={label} className="h-8 bg-slate-800 p-0.5">
        {options.map((o) => (
          <TabsTrigger
            key={o.value}
            value={o.value}
            className="h-7 px-2.5 text-xs text-slate-300 data-[state=active]:bg-indigo-600 data-[state=active]:text-white"
          >
            {o.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
