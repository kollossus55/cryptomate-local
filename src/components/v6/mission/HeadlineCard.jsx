// The one line that says what V6 is doing and why. Wording and precedence are decided by
// the server (status.headline) so they are tested in one place; this only renders them.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertOctagon,
  Banknote,
  ChevronDown,
  CircleDot,
  Hand,
  PowerOff,
  ShieldAlert,
  ShieldQuestion,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { createPageUrl } from '@/components/utils';
import { StaleBadge, toneOf } from '../shared/ToneBadge';
import { useV6Query } from '../shared/useV6';

const STATE_ICON = {
  ENGINE_DOWN: PowerOff,
  HALTED: AlertOctagon,
  PAUSED: Hand,
  NEEDS_REVIEW: ShieldQuestion,
  NO_CERTIFIED: Banknote,
  ENTRIES_BLOCKED: ShieldAlert,
  HOLDING: CircleDot,
  WAITING: Banknote,
};

// These states wait on a person, so the way forward sits on the card itself.
const NEEDS_ACTION = {
  HALTED: 'Review in Risk Controls',
  PAUSED: 'Open Risk Controls',
  NEEDS_REVIEW: 'A human must re-enable this in Risk Controls',
};

const pageLink = ({ page, query }) => `${createPageUrl(page)}${query ? `?${query}` : ''}`;

/**
 * Day-one counts, from the strategy list. status.strategies is not used: its `failed`
 * count is not filled in, and "0 failed" here would be a false statement.
 */
export function candidateLine(items) {
  const tested = items.filter((s) => s.certificate?.status && s.certificate.status !== 'none');
  if (!tested.length) return 'No candidate has finished testing yet.';
  const passed = tested.filter((s) => s.certificate.status === 'valid').length;
  const shadow = items.filter((s) => s.lifecycle === 'shadow').length;
  const noun = tested.length === 1 ? 'candidate' : 'candidates';
  return `${tested.length} ${noun} tested. ${passed} passed.${shadow ? ` ${shadow} running in shadow, logging only.` : ''}`;
}

function NoCertifiedNote() {
  const strategies = useV6Query('strategies');
  return (
    <div className="mt-3 space-y-2 border-t border-slate-800 pt-3 text-sm text-slate-300">
      <p>
        This is an expected result, not a fault. V6 only trades strategies that pass fixed tests on past data, net of
        costs. Sitting in cash beats trading rules with no tested edge.
      </p>
      <p className="text-slate-400">
        {strategies.data?.items ? `${candidateLine(strategies.data.items)} ` : ''}
        <Link to={createPageUrl('Strategies')} className="text-slate-200 underline underline-offset-2">
          See each candidate's results
        </Link>
      </p>
    </div>
  );
}

/** Merges reasons and block reasons so "why" is never empty while entries are shut. */
function collectReasons(headline, blockReasons) {
  const reasons = [...(headline.reasons ?? [])];
  const seen = new Set(reasons.map((r) => r.text));
  for (const text of blockReasons ?? []) {
    if (!seen.has(text)) reasons.push({ text });
  }
  return reasons;
}

export default function HeadlineCard({ status, stale }) {
  const [open, setOpen] = useState(false);
  const headline = status.headline;

  if (!headline) {
    return (
      <Card className="border-slate-700 bg-slate-900/60">
        <CardContent className="p-5 text-sm text-slate-300">
          The server did not say what V6 is doing, so no state is shown here.
        </CardContent>
      </Card>
    );
  }

  const tone = toneOf(headline.tone);
  const Icon = STATE_ICON[headline.state] ?? CircleDot;
  const reasons = collectReasons(headline, status.risk?.blockReasons);
  // With positions still open this state reads CLOSING, so "expected result" would be wrong.
  const dayOne = headline.state === 'NO_CERTIFIED' && !status.positions?.length;
  // Review can be raised on a state the headline does not name, such as flat on half size.
  const action = NEEDS_ACTION[headline.state] ?? (status.risk?.review?.needed ? NEEDS_ACTION.NEEDS_REVIEW : null);

  return (
    <Card className={tone.card}>
      <CardContent className="p-5">
        <div className="flex items-start gap-3">
          <Icon className={`mt-0.5 h-6 w-6 shrink-0 ${tone.icon}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-wide text-slate-100">{headline.title}</h2>
              {stale && <StaleBadge />}
            </div>
            <p className="mt-1 text-sm text-slate-200">{headline.line}</p>
          </div>
        </div>

        {action && (
          <p className="mt-3 text-sm">
            <Link to={createPageUrl('RiskControls')} className="text-slate-100 underline underline-offset-2">
              {action}
            </Link>
          </p>
        )}

        {dayOne && <NoCertifiedNote />}

        {reasons.length > 0 && (
          <Collapsible open={open} onOpenChange={setOpen} className="mt-3">
            <CollapsibleTrigger className="inline-flex items-center gap-1 text-xs text-slate-300 underline underline-offset-2 hover:text-white">
              Why this state?
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">
                {reasons.map((r) => (
                  <li key={r.text}>
                    {r.text}
                    {r.link && (
                      <>
                        {' '}
                        <Link to={pageLink(r.link)} className="text-slate-200 underline underline-offset-2">
                          Open
                        </Link>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}
