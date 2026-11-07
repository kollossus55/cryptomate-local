// Current state, pause, flatten, and the halt and re-enable flow (gui-design 5.4). This is
// the safety-critical part of the GUI, so the rule for each state lives in haltLogic.js.
// The server re-checks every precondition; nothing here is what makes an action safe.
import React, { useState } from 'react';
import { AlertOctagon, AlertTriangle, CheckCircle2, Clock, Hand, Info, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import CheckIcon from '../shared/CheckIcon';
import { StaleBadge, toneOf } from '../shared/ToneBadge';
import TypedConfirmDialog from '../shared/TypedConfirmDialog';
import { allTimeLabel } from '../shared/useAllTimeDrawdown';
import { NEXT_TICK_NOTE, useV6Mutation } from '../shared/useV6';
import { coin, money, pct, pnlCls, signedMoney, until, utc } from '../shared/format';
import { panelActions, rebaseExposure, REQUEST_TEXT, reviewText, selfClearingBlocks } from './haltLogic';

const WRITE = { invalidates: ['status', 'events'] };
const SIZE_TEXT = ['Full size', 'Half size', 'Quarter size', 'No new entries', 'No new entries'];

const MODES = {
  fail_safe: { tone: 'red', icon: AlertOctagon, title: 'HALTED' },
  halted: { tone: 'red', icon: AlertOctagon, title: 'HALTED' },
  paused: { tone: 'amber', icon: Hand, title: 'PAUSED BY YOU' },
  review: { tone: 'amber', icon: ShieldQuestion },
};

function HaltFacts({ status, mode }) {
  const { risk, positions } = status;
  const h = risk.halted;
  if (mode === 'fail_safe') {
    return <p>Stored risk state could not be read. Halted until you re-enable. The ladder's equity high is unknown, so no ladder drawdown is shown.</p>;
  }
  if (mode === 'review') return <p>{reviewText(risk, pct).body}</p>;
  if (mode === 'paused') {
    return (
      <>
        <p>
          You paused new entries at {utc(h.at)}.
          {positions?.length ? ` ${positions.length} open position${positions.length === 1 ? ' is' : 's are'} still managed by exit plans.` : ''}
        </p>
        {h.reason && <p className="text-slate-400">Reason: {h.reason}</p>}
      </>
    );
  }
  const manual = h.source === 'manual';
  const loss = typeof h.peakEquity === 'number' && typeof h.equity === 'number' ? h.peakEquity - h.equity : null;
  return (
    <>
      <p>
        {manual ? 'You asked V6 to flatten and halt' : 'Flatten and halt triggered'} {utc(h.at)}
        {typeof h.drawdownPct === 'number' ? ` at ${pct(h.drawdownPct)} drawdown` : ''}.
      </p>
      {loss !== null && (
        <p>
          Peak {money(h.peakEquity)} to equity {money(h.equity)}. Paper loss from peak {money(loss)}.
        </p>
      )}
      {h.reason && <p className="text-slate-400">Reason: {h.reason}</p>}
    </>
  );
}

function Preconditions({ risk }) {
  const items = risk.reenable?.preconditions ?? [];
  const unavailable = risk.reenable?.available !== true && items.every((p) => p.ok);
  return (
    <div className="space-y-1">
      {items.length > 0 && <p className="text-slate-400">Before re-enabling:</p>}
      {unavailable && <p className="text-amber-200">The server is not offering a re-enable in this state yet.</p>}
      <ul className="space-y-1">
        {items.map((p) => (
          <li key={p.id} className="flex items-start gap-2">
            <CheckIcon status={p.ok ? 'pass' : 'fail'} label={p.ok ? 'Met' : 'Not met'} className="mt-0.5 h-4 w-4" />
            <span>{p.label}</span>
          </li>
        ))}
      </ul>
      <p className="flex items-start gap-2 text-slate-400">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        Price data is {risk.dataOk ? 'healthy' : 'not healthy'}. Entries also need healthy data after re-enabling.
      </p>
    </div>
  );
}

/** Shown first in the dialog: this is the cost of confirming, so it is not a footnote. */
function RebaseExposure({ exposure }) {
  const { atLeast, reenables } = exposure;
  const prefix = atLeast ? 'at least ' : '';
  const history = reenables === null ? '' : reenables === 0 ? ' No earlier re-enables.' : ` Across ${reenables} earlier ${reenables === 1 ? 're-enable' : 're-enables'}.`;
  const same = Math.abs((exposure.nextHaltFromAllTimePct ?? 0) - (exposure.haltPct ?? 0)) < 0.05;
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-100">
      {exposure.known ? (
        <p>
          <span className="font-semibold">Now:</span> {prefix}{pct(exposure.nowFromAllTimePct)} from the all-time high of{' '}
          {money(exposure.highEquity)}.{history}
        </p>
      ) : (
        <p>
          <span className="font-semibold">Now:</span> the all-time high is not available, so the total fall across re-enables cannot
          be shown. It may be larger than the drawdown on this page.
        </p>
      )}
      {exposure.nextHaltEquity === null ? (
        <p>
          <span className="font-semibold">Next automatic flatten:</span> the level cannot be worked out right now.
        </p>
      ) : (
        <p>
          <span className="font-semibold">Next automatic flatten:</span> at about {money(exposure.nextHaltEquity)}, which is{' '}
          {pct(exposure.haltPct, 0)} from the new high
          {exposure.nextHaltFromAllTimePct === null ? (
            '.'
          ) : (
            <>
              {' '}{same ? 'and' : 'but'} {prefix}{pct(exposure.nextHaltFromAllTimePct)} from the all-time high.
            </>
          )}
        </p>
      )}
      <p className="text-xs text-amber-200/80">The engine sets the new high at its next run, so the level can move slightly.</p>
    </div>
  );
}

function RebaseDialogBody({ status, allTime }) {
  const { account, risk } = status;
  const exposure = rebaseExposure(allTime, account?.equity, risk.ladder?.haltPct);
  const allowance = pct(Math.abs(risk.ladder?.haltPct), 0);
  const label = allTimeLabel(allTime, pct);
  return (
    <>
      <RebaseExposure exposure={exposure} />
      <p>This does not fix whatever caused the loss. It lets V6 open paper positions again under the same rules.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>The equity high resets to {money(account?.equity)}, so the ladder restarts from there. Without this it would stay stopped.</li>
        <li>
          That gives V6 a fresh {allowance} allowance on top of the loss so far. Your account could fall a further {allowance}{' '}
          from here before the next halt. Repeated re-enables have no combined limit.
        </li>
        <li>
          The chart and worst-drawdown record still show the old high.
          {label ? ` Mission Control keeps showing the fall from the all-time high, now ${label.toLowerCase()}.` : ''}
        </li>
        <li>Daily, weekly, market and data blocks are not cleared by this.</li>
        <li>Strategies keep their current lifecycle state.</li>
      </ul>
    </>
  );
}

function FlattenDialogBody({ positions }) {
  return (
    <>
      <p>
        Closes every paper position at the next engine run, at market, and halts new entries. Only a re-enable clears the halt.
        Fills may be worse than the current prices.
      </p>
      <ul className="space-y-1">
        {positions.map((p) => (
          <li key={`${p.symbol}-${p.strategyId}`} className="flex justify-between gap-4">
            <span className="text-slate-200">{coin(p.symbol)}</span>
            <span className={pnlCls(p.unrealized)}>{signedMoney(p.unrealized)} paper</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function SummaryLine({ status }) {
  const { risk, headline } = status;
  const open = risk?.canEnter === true && headline?.state !== 'NO_CERTIFIED';
  if (open) {
    return (
      <p className="flex items-start gap-2 text-slate-100">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
        Entries allowed. {SIZE_TEXT[risk.rung] ?? ''}. Drawdown {pct(risk.drawdownPct)}.
      </p>
    );
  }
  return <p className="text-slate-100">{headline?.line ?? 'State not available.'}</p>;
}

export default function HaltPanel({ status, allTime, stale }) {
  const { toast } = useToast();
  const [dialog, setDialog] = useState(null); // 'pause' | 'flatten' | 'reenable' | null
  const pause = useV6Mutation('pauseEntries', WRITE);
  const flatten = useV6Mutation('flattenAll', WRITE);
  const reenable = useV6Mutation('reenable', WRITE);

  const { risk, positions, headline, engine } = status;
  const actions = panelActions(status);
  const { mode, willRebase } = actions;
  const look = MODES[mode];
  const tone = toneOf(look?.tone ?? 'slate');
  const Icon = look?.icon;
  const engineDown = engine?.stale === true || headline?.state === 'ENGINE_DOWN';
  const blocks = selfClearingBlocks(risk, until);
  const label = allTimeLabel(allTime, pct);
  const reenableLabel = willRebase ? 'Review and re-enable...' : 'Resume new entries';

  const done = (title) => () => toast({ title: `${title} ${NEXT_TICK_NOTE}` });

  return (
    <Card className={look ? tone.card : 'border-slate-800 bg-slate-900/60'}>
      <CardContent className="space-y-3 p-5 text-sm text-slate-300">
        <div className="flex flex-wrap items-center gap-2">
          {Icon && <Icon className={`h-5 w-5 ${tone.icon}`} aria-hidden="true" />}
          <h2 className="text-base font-semibold text-slate-100">
            {mode === 'review' ? reviewText(risk, pct).title : look?.title ?? 'Current state'}
          </h2>
          {stale && <StaleBadge />}
        </div>

        {mode === 'normal' ? <SummaryLine status={status} /> : <HaltFacts status={status} mode={mode} />}

        {label && (
          <p className="text-slate-400">
            All-time: {label} from {money(allTime.highEquity)}. This does not reset on a re-enable.
          </p>
        )}

        {mode === 'normal' && risk?.blockReasons?.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-5 text-slate-400">
            {risk.blockReasons.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        )}

        {blocks.length > 0 && (
          <ul className="space-y-0.5 text-slate-400">
            {blocks.map((text) => (
              <li key={text} className="flex items-start gap-2">
                <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {text}
              </li>
            ))}
          </ul>
        )}

        {actions.showReenable && <Preconditions risk={risk} />}

        {actions.pending && (
          <p className="flex items-start gap-2 text-amber-200">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {REQUEST_TEXT[actions.pending] ?? NEXT_TICK_NOTE}
          </p>
        )}

        {engineDown && (
          <p className="flex items-start gap-2 text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            The engine is not running, so any request here waits until it next runs.
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {mode === 'normal' && (
            <Button size="sm" variant="outline" className="border-slate-700" disabled={!actions.canPause} onClick={() => setDialog('pause')}>
              Pause new entries
            </Button>
          )}
          {actions.showReenable && (
            <Button
              size="sm"
              className="bg-indigo-600 text-white hover:bg-indigo-500"
              disabled={!actions.canReenable}
              onClick={() => setDialog('reenable')}
            >
              {reenableLabel}
            </Button>
          )}
          {actions.canFlatten && (
            <Button size="sm" variant="outline" className="border-red-500/50 text-red-300" onClick={() => setDialog('flatten')}>
              Flatten all paper
            </Button>
          )}
        </div>
      </CardContent>

      <TypedConfirmDialog
        open={dialog === 'pause'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Pause new entries?"
        noteLabel="Why are you pausing? (required)"
        confirmLabel="Pause new entries"
        onConfirm={({ note }) => pause.mutateAsync({ reason: note }).then(done('Pause requested.'))}
      >
        <p>V6 stops opening positions. Open positions stay under their exit plans, and exits continue.</p>
        <p>This can take up to 5 minutes. Resuming is a separate step on this page.</p>
      </TypedConfirmDialog>

      <TypedConfirmDialog
        open={dialog === 'flatten'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Flatten all paper positions?"
        word="FLATTEN"
        noteLabel="Why are you flattening? (required)"
        confirmLabel="Flatten all paper"
        destructive
        onConfirm={({ note }) => flatten.mutateAsync({ confirm: 'FLATTEN', reason: note }).then(done('Flatten requested.'))}
      >
        <FlattenDialogBody positions={positions ?? []} />
      </TypedConfirmDialog>

      <TypedConfirmDialog
        open={dialog === 'reenable'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={willRebase ? 'Re-enable V6 paper trading' : 'Resume new entries?'}
        word={willRebase ? 'RE-ENABLE' : undefined}
        noteLabel={willRebase ? 'Why are you re-enabling? (required)' : 'Why are you resuming? (required)'}
        confirmLabel={willRebase ? 'Re-enable' : 'Resume new entries'}
        onConfirm={({ note }) =>
          reenable.mutateAsync({ confirm: willRebase ? 'RE-ENABLE' : 'RESUME', note }).then(done('Requested.'))
        }
      >
        {willRebase ? (
          <RebaseDialogBody status={status} allTime={allTime} />
        ) : (
          <p>V6 can open paper positions again. The equity high stays where it is, so reduced size carries on as before.</p>
        )}
      </TypedConfirmDialog>
    </Card>
  );
}
