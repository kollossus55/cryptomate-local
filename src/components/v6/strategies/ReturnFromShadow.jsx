import React, { useState } from "react";
import { Hourglass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import {
  CheckIcon, NEXT_TICK_NOTE, ToneBadge, TypedConfirmDialog, V6Card, useV6Mutation, utc,
} from "../shared";
import { RETURN_CONFIRM_WORD, shadowReturnState } from "./strategyView";

const INVALIDATES = ["strategies", "strategyDetail", "status"];

// Contract section 6: demotion is automatic, promotion never is. This is the only
// lifecycle change the GUI can ask for, and the server re-checks every condition.
export default function ReturnFromShadow({ strategy, certificate }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const mutation = useV6Mutation("returnFromShadow", { invalidates: INVALIDATES });
  const state = shadowReturnState({ strategy, certificate });
  if (!state.applicable) return null;

  const confirm = async ({ note }) => {
    await mutation.mutateAsync({ id: strategy.id, confirm: RETURN_CONFIRM_WORD, note });
    toast({ title: "Return requested", description: NEXT_TICK_NOTE });
  };

  return (
    <V6Card
      title="Return from shadow"
      actions={state.pending ? <ToneBadge tone="amber" icon={Hourglass}>Requested</ToneBadge> : null}
    >
      <div className="space-y-3 text-sm">
        {state.wasDemoted ? (
          <p className="text-slate-300">
            Demoted {utc(strategy.demotedAt)}
            {strategy.demotionReason ? `: ${strategy.demotionReason}` : "."}
          </p>
        ) : (
          <p className="text-slate-300">
            This candidate logs signals in shadow because it did not pass its tests. There is no route
            from here to paper. Only a new version that passes every test can trade.
          </p>
        )}

        <ul className="space-y-1.5">
          {state.preconditions.map((p) => (
            <li key={p.id} className="flex items-start gap-2">
              <CheckIcon status={p.ok ? "pass" : "fail"} label={p.ok ? "Met" : "Not met"} />
              <span className="text-slate-300">{p.label}</span>
            </li>
          ))}
        </ul>

        {state.serverReason && <p className="text-slate-400">{state.serverReason}</p>}

        {state.wasDemoted && (
          <>
            <p className="text-xs text-slate-400">
              This never happens by itself. It needs your decision, and it restarts at half risk. Leaving
              the expected range restarts the count.
            </p>
            {state.pending ? (
              <p className="text-slate-300">{NEXT_TICK_NOTE}</p>
            ) : (
              <Button
                size="sm" variant="outline" className="border-slate-700"
                disabled={!state.canRequest} onClick={() => setOpen(true)}
              >
                Review return to paper...
              </Button>
            )}
          </>
        )}
      </div>

      <TypedConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Return ${strategy.name ?? strategy.id} to paper?`}
        word={RETURN_CONFIRM_WORD}
        noteLabel="Why are you returning it? (required)"
        confirmLabel="Return to paper"
        onConfirm={confirm}
      >
        <p>
          {state.inRange} of {state.required} forward shadow signals are back inside the expected range.
          That is a small sample, and it does not say the earlier breach was noise.
        </p>
        <ul className="list-disc space-y-1 pl-4">
          <li>It restarts at half risk, and stays there until its forward trades are complete again.</li>
          <li>It can open paper positions, and those can lose.</li>
          <li>The drift monitor keeps running and can demote it again.</li>
          <li>This has no effect on live trading. V6 cannot reach it.</li>
        </ul>
        <p className="text-xs text-slate-400">{NEXT_TICK_NOTE}</p>
      </TypedConfirmDialog>
    </V6Card>
  );
}
