// Starts V6 over on an account that lost its engine state. Hidden unless recutoverOffer says
// the state is really gone and the account is flat. The server re-checks both.
import React, { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { InlineError } from '../shared/StateCard';
import TypedConfirmDialog from '../shared/TypedConfirmDialog';
import { NEXT_TICK_NOTE, useV6Mutation, useV6Query } from '../shared/useV6';
import { money } from '../shared/format';
import { recutoverOffer } from './haltLogic';

function WhatItResets({ equity }) {
  return (
    <>
      <p>Only do this if the engine state cannot be restored. It cannot be undone.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>The all-time high and the ladder's equity high restart from today's equity, {money(equity)}.</li>
        <li>Any halt on record, the drawdown so far and the re-enable count are gone from the engine.</li>
        <li>The fall from the old all-time high stops being shown, so a loss before today no longer counts against any limit.</li>
        <li>Cash, realized paper P&amp;L and the trade count stay as they are.</li>
      </ul>
    </>
  );
}

export default function RecutoverPanel({ status }) {
  const lost = !status.engine?.lastTickAt;
  const events = useV6Query('events', { onlyOpen: true, limit: 50 }, { enabled: lost });
  const recutover = useV6Mutation('recutover', { invalidates: ['status', 'events'] });
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  if (!lost) return null;
  if (events.isError) return <InlineError error={events.error} label="Could not check for lost engine state" onRetry={() => events.refetch()} />;
  const offer = recutoverOffer(status, events.data?.items);
  if (!offer.stateLost) return null;

  return (
    <section className="space-y-3 rounded-xl border border-red-500/60 bg-red-500/10 p-4 text-sm">
      <h2 className="text-base font-semibold text-red-100">V6 has lost its engine state and has stopped</h2>
      <p className="text-slate-200">
        Stops are not being checked. V6 will not start over by itself, because that would wipe the halt, the high and the history.
      </p>
      {offer.available ? (
        <Button className="bg-red-700 hover:bg-red-600" onClick={() => setOpen(true)}>
          <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
          Start V6 over...
        </Button>
      ) : (
        <p className="text-amber-200">Starting over needs a flat account with no unreadable rows. Repair or close those first.</p>
      )}
      <TypedConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Start V6 over on this account"
        word="RECUTOVER"
        confirmLabel="Start over"
        destructive
        onConfirm={() =>
          recutover.mutateAsync({ confirm: 'RECUTOVER' }).then(() => {
            setOpen(false);
            toast({ title: 'Requested.', description: NEXT_TICK_NOTE });
          })
        }
      >
        <WhatItResets equity={status.account?.equity} />
      </TypedConfirmDialog>
    </section>
  );
}
