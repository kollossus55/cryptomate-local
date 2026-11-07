// A check result. `not_run` must never look like a pass (gui-design 5.3).
import React from 'react';
import { Check, Minus, X } from 'lucide-react';

const STATES = {
  pass: { Icon: Check, cls: 'text-emerald-400', label: 'Passed' },
  fail: { Icon: X, cls: 'text-red-400', label: 'Failed' },
  not_run: { Icon: Minus, cls: 'text-slate-500', label: 'Not run' },
};

export default function CheckIcon({ status, label, className = 'h-4 w-4' }) {
  const { Icon, cls, label: fallback } = STATES[status] ?? STATES.not_run;
  return (
    <span role="img" aria-label={label ?? fallback} title={label ?? fallback} className="inline-flex">
      <Icon className={`${className} ${cls}`} aria-hidden="true" />
    </span>
  );
}
