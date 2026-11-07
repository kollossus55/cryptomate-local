// The limits form. Every number comes from riskConfig; if that read fails the form stays
// off rather than showing guessed limits. riskConfig does not poll, and drafts live apart
// from the query data, so a refetch can never overwrite unsaved edits (gui-design 9.2).
import React, { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Lock } from 'lucide-react';
import { EXIT_PROFILES } from '@shared/trading/v6Exits.js';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useToast } from '@/components/ui/use-toast';
import { InlineError, SkeletonRows, V6Card } from '../shared/StateCard';
import { ToneBadge } from '../shared/ToneBadge';
import TypedConfirmDialog from '../shared/TypedConfirmDialog';
import { NEXT_TICK_NOTE, useV6Mutation, useV6Query } from '../shared/useV6';
import LimitField from './LimitField';
import { buildFields, defaultsDiff, evaluateDrafts, formatLimit } from './limitLogic';
import { ADVANCED_GROUP, FIXED_FACTS, GROUPS } from './limitMeta';

const INVALIDATES = { invalidates: ['riskConfig', 'status', 'events'] };
const QUARTER_RUNG = 2;

function ChangeList({ changes }) {
  return (
    <ul className="space-y-1">
      {changes.map((c) => (
        <li key={c.key} className="flex flex-wrap items-center gap-2">
          <span className="text-slate-200">{c.label}</span>
          <span>
            {c.from} to {c.to}
          </span>
          {c.direction !== 'changed' && (
            <ToneBadge tone={c.direction === 'looser' ? 'amber' : 'slate'}>
              {c.direction === 'looser' ? 'Looser' : 'Tighter'}
            </ToneBadge>
          )}
        </li>
      ))}
    </ul>
  );
}

function FieldGroup({ fields, drafts, errors, disabled, onChange }) {
  return fields.map((f) => (
    <LimitField
      key={f.key}
      field={f}
      draft={drafts[f.key]}
      error={errors[f.key]}
      disabled={disabled}
      onChange={onChange}
    />
  ));
}

const factKey = (text) => text.replace(/\.$/, '').trim().toLowerCase();

/** The API's list is shorter than gui-design 5.4, so both are shown, without repeats. */
function mergeFacts(apiFacts) {
  const seen = new Set();
  return [...FIXED_FACTS, ...(apiFacts ?? [])].filter((text) => {
    const key = factKey(text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function FixedCard({ fields, facts }) {
  const costs = fields.filter((f) => f.meta.group === 'fixed');
  return (
    <V6Card title="Fixed (not editable)">
      <ul className="space-y-1 text-sm text-slate-300">
        {facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
        {costs.length > 0 && (
          <li>Cost assumptions: {costs.map((f) => `${f.meta.label.toLowerCase()} ${formatLimit(f.value, f.meta)}`).join(', ')}.</li>
        )}
        <li>
          Reward:risk minimum by exit profile:{' '}
          {Object.entries(EXIT_PROFILES)
            .map(([name, profile]) => `${name} ${profile.minRewardRisk}`)
            .join(', ')}
          .
        </li>
      </ul>
    </V6Card>
  );
}

function Form({ data, query, rung, halted }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState({});
  const [serverErrors, setServerErrors] = useState({});
  const [conflict, setConflict] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [dialog, setDialog] = useState(null); // 'save' | 'reset' | null

  const save = useV6Mutation('setRiskConfig', INVALIDATES);
  const reset = useV6Mutation('resetRiskConfig', INVALIDATES);

  // Status polls and riskConfig does not, so use whichever noticed the drawdown first.
  const loosenBlocked = data.loosenBlocked === true || rung >= QUARTER_RUNG || !!halted;

  const fields = useMemo(() => buildFields(data), [data]);
  const { patch, changes, errors: localErrors } = useMemo(
    () => evaluateDrafts(fields, drafts, { loosenBlocked }),
    [fields, drafts, loosenBlocked],
  );
  const errors = { ...serverErrors, ...localErrors };
  const resetChanges = useMemo(() => defaultsDiff(fields), [fields]);

  const known = new Set(GROUPS.map((g) => g.id));
  const inGroup = (id) => fields.filter((f) => f.meta.group === id);
  const advanced = fields.filter((f) => !known.has(f.meta.group) && f.meta.group !== 'fixed');
  const advancedHasError = advanced.some((f) => errors[f.key]);

  const onChange = (key, text) => {
    setDrafts((d) => ({ ...d, [key]: text }));
    setServerErrors(({ [key]: _gone, ...rest }) => rest);
  };

  const discard = () => {
    setDrafts({});
    setServerErrors({});
    setConflict(false);
  };

  // The response is the server's own record, so this is not an optimistic update. It stops
  // the old values flashing back between clearing the drafts and the refetch landing.
  const applyResponse = (res) => {
    qc.setQueryData(['v6', 'riskConfig', null], (old) => (old ? { ...old, version: res.version, config: res.config ?? old.config } : old));
    discard();
    toast({ title: `Saved. ${NEXT_TICK_NOTE}` });
  };

  const noteRefusal = (err) => {
    if (err.code === 'VERSION_CONFLICT') setConflict(true);
    if (err.fields) setServerErrors(err.fields);
    throw err;
  };

  const submitSave = () => save.mutateAsync({ patch, expectedVersion: data.version }).then(applyResponse, noteRefusal);
  const submitReset = () => reset.mutateAsync({ expectedVersion: data.version }).then(applyResponse, noteRefusal);

  const dirtyCount = changes.length;
  const hasErrors = Object.keys(errors).length > 0;
  const busy = save.isPending || reset.isPending;

  return (
    <>
      {loosenBlocked && (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          Limits can only be tightened right now. Loosening is refused on the quarter-size rung or worse, so limits cannot
          move during a drawdown.
        </p>
      )}

      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">These settings changed elsewhere. Reload to see the latest. Your edits stay here.</span>
          <Button
            size="sm"
            variant="outline"
            className="border-slate-700"
            onClick={() => query.refetch().then(() => setConflict(false))}
          >
            Reload
          </Button>
        </div>
      )}

      {GROUPS.map((group) => (
        <V6Card key={group.id} title={group.title}>
          <FieldGroup fields={inGroup(group.id)} drafts={drafts} errors={errors} disabled={busy} onChange={onChange} />
        </V6Card>
      ))}

      {advanced.length > 0 && (
        <Collapsible open={advancedOpen || advancedHasError} onOpenChange={setAdvancedOpen}>
          <V6Card>
            <CollapsibleTrigger className="flex w-full items-center justify-between text-base text-slate-200">
              {ADVANCED_GROUP.title}
              <ChevronDown
                className={`h-4 w-4 transition-transform ${advancedOpen || advancedHasError ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <FieldGroup fields={advanced} drafts={drafts} errors={errors} disabled={busy} onChange={onChange} />
            </CollapsibleContent>
          </V6Card>
        </Collapsible>
      )}

      <FixedCard fields={fields} facts={mergeFacts(data.fixed)} />

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-900 p-3">
        <p className="text-sm text-slate-300">
          {dirtyCount === 0 ? 'No unsaved changes' : `${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}`}
          {hasErrors && <span className="ml-2 text-red-300">Fix the marked limits to save.</span>}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="text-slate-300 hover:bg-slate-800 hover:text-white"
            disabled={busy || resetChanges.length === 0}
            onClick={() => setDialog('reset')}
          >
            Reset to defaults
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-slate-700"
            disabled={busy || Object.keys(drafts).length === 0}
            onClick={discard}
          >
            Discard
          </Button>
          <Button
            size="sm"
            className="bg-indigo-600 text-white hover:bg-indigo-500"
            disabled={busy || dirtyCount === 0 || hasErrors}
            onClick={() => setDialog('save')}
          >
            Save...
          </Button>
        </div>
      </div>

      <TypedConfirmDialog
        open={dialog === 'save'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Save these limits?"
        confirmLabel="Save limits"
        onConfirm={submitSave}
      >
        <ChangeList changes={changes} />
        <p>{NEXT_TICK_NOTE}</p>
      </TypedConfirmDialog>

      <TypedConfirmDialog
        open={dialog === 'reset'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Reset all limits to defaults?"
        confirmLabel="Reset limits"
        onConfirm={submitReset}
      >
        <ChangeList changes={resetChanges} />
        <p>Any unsaved edits on this page are dropped. {NEXT_TICK_NOTE}</p>
      </TypedConfirmDialog>
    </>
  );
}

export default function RiskForm({ rung, halted }) {
  const config = useV6Query('riskConfig');

  if (config.isPending) {
    return (
      <V6Card title="Limits">
        <SkeletonRows rows={6} height="h-10" />
      </V6Card>
    );
  }
  if (config.data === undefined) {
    return (
      <V6Card title="Limits">
        <InlineError error={config.error} label="Could not load limits, so editing is off" onRetry={() => config.refetch()} />
      </V6Card>
    );
  }
  return <Form data={config.data} query={config} rung={rung ?? 0} halted={halted} />;
}
