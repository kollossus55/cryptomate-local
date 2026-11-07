// One limit: input, default, allowed range and help text. Help stays visible rather than
// hiding in a tooltip, because it also has to work on a phone.
import React from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatLimit, toInput } from './limitLogic';

export default function LimitField({ field, draft, error, disabled, onChange }) {
  const { key, meta, ceiling, value, defaultValue, editable } = field;
  const id = `limit-${key}`;
  const shown = draft ?? toInput(value, meta);
  const dollar = meta.unit === '$';
  const suffix = dollar ? '' : (meta.unit ?? '').trim();

  return (
    <div className="grid gap-x-4 gap-y-1 border-t border-slate-800 py-3 first:border-t-0 md:grid-cols-[14rem_9rem_1fr]">
      <Label htmlFor={id} className="self-center text-sm text-slate-200">
        {meta.label}
      </Label>
      <div className="flex items-center gap-1.5 text-sm text-slate-300">
        {meta.sign === -1 && <span aria-hidden="true">-</span>}
        {dollar && <span aria-hidden="true">$</span>}
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          value={shown}
          disabled={disabled || !editable}
          onChange={(e) => onChange(key, e.target.value)}
          aria-invalid={!!error}
          aria-describedby={`${id}-info`}
          className={`h-8 w-20 bg-slate-950 text-right text-slate-100 ${error ? 'border-red-500' : 'border-slate-700'}`}
        />
        {suffix && <span aria-hidden="true">{suffix}</span>}
      </div>
      <div id={`${id}-info`} className="min-w-0 text-xs text-slate-400">
        <p className="text-slate-300">
          Default {formatLimit(defaultValue, meta)}.{' '}
          {ceiling ? (
            <>
              Allowed {formatLimit(ceiling.min, meta)} to {formatLimit(ceiling.max, meta)}.
            </>
          ) : (
            'Allowed range not available, so this cannot be edited.'
          )}
        </p>
        {meta.help && <p>{meta.help}</p>}
        {meta.why && <p className="text-slate-500">{meta.why}</p>}
        {meta.clears && <p className="text-slate-500">Clears: {meta.clears}</p>}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-300 md:col-span-3">
          {error}
        </p>
      )}
    </div>
  );
}
