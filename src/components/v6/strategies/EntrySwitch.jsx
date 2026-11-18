import React, { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { NEXT_TICK_NOTE, TypedConfirmDialog, describeV6Error, useV6Mutation } from "../shared";
import { canTrade } from "./strategyView";

const INVALIDATES = ["strategies", "strategyDetail", "status"];

// `research` has no switch at all: the API refuses it, and nothing here may imply
// that an uncertified strategy could be turned on.
export default function EntrySwitch({ strategy, showLabel = true }) {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [closePositions, setClosePositions] = useState(false);
  const mutation = useV6Mutation("setStrategyEnabled", { invalidates: INVALIDATES });
  const shadow = strategy.lifecycle === "shadow";
  if (!canTrade(strategy) && !shadow) return null;

  const label = shadow ? "Log shadow signals" : "Allow new entries";
  const enabled = strategy.operatorEnabled === true;

  const apply = async (next, close = false) => {
    await mutation.mutateAsync({ id: strategy.id, enabled: next, closePositions: close });
    toast({ title: "Saved", description: NEXT_TICK_NOTE });
  };

  const onToggle = (next) => {
    if (!next) {
      setClosePositions(false);
      setConfirming(true);
      return;
    }
    apply(true).catch((err) => {
      toast({ variant: "destructive", title: "Not saved", description: describeV6Error(err).message });
    });
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Switch
          checked={enabled} onCheckedChange={onToggle} disabled={mutation.isPending}
          aria-label={`${label}: ${strategy.name ?? strategy.id}`}
        />
        {showLabel && <span className="text-sm text-slate-200">{label}</span>}
      </div>

      <TypedConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={shadow ? `Stop logging ${strategy.name ?? strategy.id}?` : `Stop new entries for ${strategy.name ?? strategy.id}?`}
        confirmLabel={shadow ? "Stop logging" : "Stop new entries"}
        onConfirm={() => apply(false, closePositions)}
      >
        {shadow ? (
          <p>
            Shadow signals stop being logged. It never holds a position, so nothing closes. Signals that
            are not logged do not count towards a return to paper.
          </p>
        ) : (
          <>
            <p>New entries stop. Open positions stay under their exit plans, and stops keep working.</p>
            <div className="flex items-start gap-2 pt-1">
              <Checkbox
                id={`close-${strategy.id}`} checked={closePositions}
                onCheckedChange={(v) => setClosePositions(v === true)}
              />
              <Label htmlFor={`close-${strategy.id}`} className="font-normal leading-snug text-slate-300">
                Also close this strategy's open positions at the next engine run
              </Label>
            </div>
          </>
        )}
        <p className="text-xs text-slate-400">{NEXT_TICK_NOTE}</p>
      </TypedConfirmDialog>
    </>
  );
}
