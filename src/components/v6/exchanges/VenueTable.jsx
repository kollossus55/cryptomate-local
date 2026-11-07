import React from 'react';
import { ArrowDown, ArrowUp, Loader2, Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { DASH, ago, utcTime } from '@/components/v6/shared';
import VenueHealthBadge from './VenueHealthBadge';
import { displayHealth, venueRoles } from './venueDraft';

const latency = (ms) => (Number.isFinite(ms) ? `${ms.toLocaleString('en-US')} ms` : DASH);

function LastError({ text, at }) {
  if (!text) return DASH;
  return (
    <span className="block max-w-[14rem] break-words text-slate-300">
      {text}
      {Number.isFinite(at) && <span className="text-slate-500"> {utcTime(at)} UTC</span>}
    </span>
  );
}

function TestResult({ outcome }) {
  if (outcome.error) {
    return <p className="text-red-300">Test could not run: {outcome.error}</p>;
  }
  const { steps = [], testedAt } = outcome.result ?? {};
  return (
    <p className="text-slate-300">
      {steps.map((s) => `${s.name} ${s.ok ? 'OK' : 'failed'}${Number.isFinite(s.ms) ? ` ${s.ms} ms` : ''}${s.detail ? ` (${s.detail})` : ''}`).join(', ')}
      {Number.isFinite(testedAt) && <span className="text-slate-500">. Tested {utcTime(testedAt)} UTC.</span>}
    </p>
  );
}

/**
 * rows: server venue rows in the staged order, with `enabled` from the draft. Health,
 * latency and errors always come from the server; order and on/off are the staged edit.
 */
export default function VenueTable({ rows, draft, onMove, onToggle, onTest, testing, coolingDown, results }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400">
            <th className="py-2 pr-3 font-medium">Priority</th>
            <th className="py-2 pr-3 font-medium">Venue</th>
            <th className="py-2 pr-3 font-medium">On</th>
            <th className="py-2 pr-3 font-medium">Health</th>
            <th className="py-2 pr-3 font-medium">Latency</th>
            <th className="py-2 pr-3 font-medium">Last OK</th>
            <th className="py-2 pr-3 font-medium">Last error</th>
            <th className="py-2 pr-3 font-medium">Roles</th>
            <th className="py-2 font-medium"><span className="sr-only">Test</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v, i) => (
            <React.Fragment key={v.venue}>
              <tr className="border-t border-slate-800 align-top text-slate-200">
                <td className="whitespace-nowrap py-2 pr-3">
                  <Button
                    size="icon" variant="ghost" className="h-7 w-7" disabled={i === 0}
                    aria-label={`Move ${v.label} up`} onClick={() => onMove(v.venue, -1)}
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    size="icon" variant="ghost" className="h-7 w-7" disabled={i === rows.length - 1}
                    aria-label={`Move ${v.label} down`} onClick={() => onMove(v.venue, 1)}
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <span className="ml-1 text-slate-400">{i + 1}</span>
                </td>
                <td className="whitespace-nowrap py-2 pr-3 font-medium">{v.label}</td>
                <td className="py-2 pr-3">
                  <Switch
                    checked={v.enabled} aria-label={`${v.label} enabled`}
                    onCheckedChange={(on) => onToggle(v.venue, on)}
                  />
                </td>
                <td className="py-2 pr-3"><VenueHealthBadge state={displayHealth(v)} retryInMs={v.retryInMs} /></td>
                <td className="whitespace-nowrap py-2 pr-3">{latency(v.latencyMs)}</td>
                <td className="whitespace-nowrap py-2 pr-3">{v.lastOk == null ? 'never' : ago(v.lastOk)}</td>
                <td className="py-2 pr-3"><LastError text={v.lastError} at={v.lastErrorAt} /></td>
                <td className="py-2 pr-3 text-xs text-slate-400">{venueRoles(draft, v.venue).join(', ') || 'None'}</td>
                <td className="py-2">
                  <Button
                    size="sm" variant="outline" className="border-slate-700"
                    disabled={testing[v.venue] || coolingDown[v.venue]}
                    aria-label={`Test ${v.label}`} onClick={() => onTest(v.venue)}
                  >
                    {testing[v.venue]
                      ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      : <Plug className="mr-1 h-3.5 w-3.5" aria-hidden="true" />}
                    Test
                  </Button>
                </td>
              </tr>
              {results[v.venue] && (
                <tr>
                  <td colSpan={9} className="pb-2 text-xs">
                    <span className="mr-1 text-slate-400">Test result, {v.label}:</span>
                    <TestResult outcome={results[v.venue]} />
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
