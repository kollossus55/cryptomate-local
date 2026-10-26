/**
 * Reset trading data.
 *
 * Irreversible from the user's point of view, so it:
 *  - states exactly what will be cleared and what will be kept, with counts
 *  - requires the word RESET to be typed
 *  - takes an automatic snapshot server-side before touching anything
 *  - refuses while a trading cycle is in flight
 *
 * The old Admin "Reset trading data" button claimed to clear the portfolio AND
 * trades but only reset the portfolio, leaving the history behind to muddy the
 * next sample. This does what it says.
 */

import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, Loader2, Check, RotateCcw, Archive } from 'lucide-react';

export default function ResetTradingData() {
  const [info, setInfo] = useState(null);
  const [confirm, setConfirm] = useState('');
  const [startingBalance, setStartingBalance] = useState('10000');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const load = async () => {
    try {
      setInfo(await base44.maintenance.resetInfo());
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await base44.maintenance.reset(confirm.trim(), Number(startingBalance));
      setDone(result);
      setConfirm('');
      setOpen(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const totalRecords = info
    ? Object.values(info.counts).reduce((a, b) => a + b, 0)
    : 0;

  if (done) {
    return (
      <div className="bg-slate-900/80 border border-emerald-800/60 rounded-xl p-6">
        <div className="flex items-center gap-3 mb-3">
          <Check className="w-5 h-5 text-emerald-400" />
          <h3 className="text-white font-medium">Trading data reset</h3>
        </div>

        <p className="text-sm text-slate-400 mb-4">
          Portfolio back to ${Number(done.startingBalance).toLocaleString()}. The next
          cycle starts a clean sample.
        </p>

        {Object.keys(done.cleared).length > 0 && (
          <ul className="text-xs text-slate-500 space-y-1 mb-4">
            {Object.entries(done.cleared).map(([name, count]) => (
              <li key={name}>• {count} {name} record{count === 1 ? '' : 's'} deleted</li>
            ))}
          </ul>
        )}

        {done.snapshot && (
          <div className="flex items-start gap-2 text-xs text-slate-500 border-t border-slate-800 pt-3">
            <Archive className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>
              A backup of the previous data was saved to
              <code className="mx-1 text-slate-400 break-all">{done.snapshot.path}</code>
              ({done.snapshot.files} files) in case you want it back.
            </span>
          </div>
        )}

        <button
          onClick={() => setDone(null)}
          className="mt-4 px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="bg-slate-900/80 border border-red-900/50 rounded-xl p-6">
      <div className="flex items-start gap-3 mb-4">
        <AlertTriangle className="w-5 h-5 text-red-400 mt-0.5" />
        <div>
          <h3 className="text-white font-medium">Reset trading data</h3>
          <p className="text-sm text-slate-400 mt-1">
            Clears the trade history and starts the paper account over. Use this
            to begin a clean measurement period.
          </p>
        </div>
      </div>

      {info && (
        <div className="grid sm:grid-cols-2 gap-4 mb-5 text-xs">
          <div>
            <p className="uppercase tracking-wide text-slate-500 mb-2">Will be deleted</p>
            <ul className="space-y-1 text-slate-400">
              {info.clears.map((name) => (
                <li key={name}>
                  • {name}
                  <span className="text-slate-600"> ({info.counts[name] ?? 0})</span>
                </li>
              ))}
              <li>• Portfolio positions, balance and P&amp;L</li>
            </ul>
          </div>
          <div>
            <p className="uppercase tracking-wide text-slate-500 mb-2">Will be kept</p>
            <ul className="space-y-1 text-slate-400">
              {info.keeps.map((name) => <li key={name}>• {name}</li>)}
              <li>• Password and two-factor</li>
            </ul>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 mb-4 text-sm text-red-400">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!open && (
        <button
          onClick={() => { setOpen(true); setError(null); }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 text-slate-200
                     text-sm hover:bg-slate-700"
        >
          <RotateCcw className="w-4 h-4" />
          Reset trading data{totalRecords ? ` (${totalRecords} records)` : ''}
        </button>
      )}

      {open && (
        <form onSubmit={submit} className="border-t border-slate-800 pt-4">
          <label className="block text-xs uppercase tracking-wide text-slate-500 mb-2">
            Starting balance
          </label>
          <input
            type="number"
            min="1"
            value={startingBalance}
            onChange={(e) => setStartingBalance(e.target.value)}
            disabled={busy}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-white
                       focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          />

          <label className="block text-xs uppercase tracking-wide text-slate-500 mt-4 mb-2">
            Type RESET to confirm
          </label>
          <input
            type="text"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
            autoComplete="off"
            placeholder="RESET"
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-white
                       tracking-widest placeholder-slate-700 focus:outline-none focus:ring-2
                       focus:ring-red-500 disabled:opacity-50"
          />

          <p className="text-xs text-slate-500 mt-3">
            A backup is saved automatically before anything is deleted.
          </p>

          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={() => { setOpen(false); setConfirm(''); setError(null); }}
              className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || confirm.trim() !== 'RESET'}
              className="px-4 py-2 rounded-lg bg-red-600/90 text-white text-sm font-medium
                         disabled:opacity-40 flex items-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Delete and reset
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
