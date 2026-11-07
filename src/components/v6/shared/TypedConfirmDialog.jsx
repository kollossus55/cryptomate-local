// Confirmation dialog for writes (gui-design 4.5). With `word`, the confirm button stays
// disabled until that word is typed (the ResetTradingData pattern). With `noteLabel`, a
// note is required as well. A refusal stays in the dialog so the context is not lost.
import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

function RefusalNote({ error }) {
  if (!error) return null;
  const fields = error.fields ? Object.values(error.fields) : [];
  return (
    <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
      {error.message}
      {fields.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {fields.map((text) => (
            <li key={String(text)}>{String(text)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * onConfirm receives { note } and returns a promise. Resolve closes the dialog; reject
 * keeps it open and shows the error.
 */
export default function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  word,
  noteLabel,
  notePlaceholder,
  confirmLabel = 'Confirm',
  destructive = false,
  onConfirm,
}) {
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setTyped('');
      setNote('');
      setError(null);
    }
  }, [open]);

  const ready = (!word || typed.trim() === word) && (!noteLabel || note.trim().length > 0);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ note: note.trim() });
      onOpenChange(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto border-slate-700 bg-slate-900 text-slate-200">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-slate-100">{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-slate-300">{children}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {noteLabel && (
          <div className="space-y-1">
            <Label htmlFor="v6-confirm-note" className="text-slate-300">
              {noteLabel}
            </Label>
            <Textarea
              id="v6-confirm-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={notePlaceholder}
              rows={2}
              className="border-slate-700 bg-slate-950 text-slate-100"
            />
          </div>
        )}

        {word && (
          <div className="space-y-1">
            <Label htmlFor="v6-confirm-word" className="text-slate-300">
              Type {word} to confirm
            </Label>
            <Input
              id="v6-confirm-word"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className="border-slate-700 bg-slate-950 text-slate-100"
            />
          </div>
        )}

        <RefusalNote error={error} />

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} className="border-slate-700 bg-transparent text-slate-200 hover:bg-slate-800 hover:text-white">
            Cancel
          </AlertDialogCancel>
          <Button
            onClick={confirm}
            disabled={!ready || busy}
            className={destructive ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-indigo-600 text-white hover:bg-indigo-500'}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
