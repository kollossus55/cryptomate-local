/**
 * Security settings.
 *
 * Two-factor enrolment and password change, for the local password lock that
 * replaced Base44's hosted sign-in.
 */

import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import TwoFactorSettings from '@/components/security/TwoFactorSettings';
import { Lock, AlertCircle, Check, Loader2 } from 'lucide-react';

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setDone(false);

    if (next.length < 8) return setError('New password must be at least 8 characters.');
    if (next !== confirm) return setError('The two new passwords do not match.');

    setBusy(true);
    try {
      await base44.auth.changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  const field = 'w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-white ' +
                'focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50';
  const label = 'block text-xs uppercase tracking-wide text-slate-500 mb-2';

  return (
    <form onSubmit={submit} className="bg-slate-900/80 border border-slate-800 rounded-xl p-6">
      <div className="flex items-start gap-3 mb-5">
        <Lock className="w-5 h-5 text-slate-400 mt-0.5" />
        <div>
          <h3 className="text-white font-medium">Password</h3>
          <p className="text-sm text-slate-400 mt-1">Changing it signs out every other session.</p>
        </div>
      </div>

      <label className={label}>Current password</label>
      <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
             disabled={busy} autoComplete="current-password" className={field} />

      <label className={`${label} mt-4`}>New password</label>
      <input type="password" value={next} onChange={(e) => setNext(e.target.value)}
             disabled={busy} autoComplete="new-password" className={field}
             placeholder="At least 8 characters" />

      <label className={`${label} mt-4`}>Confirm new password</label>
      <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
             disabled={busy} autoComplete="new-password" className={field} />

      {error && (
        <div className="flex items-start gap-2 mt-4 text-sm text-red-400">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>{error}</span>
        </div>
      )}
      {done && (
        <div className="flex items-center gap-2 mt-4 text-sm text-emerald-400">
          <Check className="w-4 h-4" /><span>Password changed.</span>
        </div>
      )}

      <button type="submit" disabled={busy}
        className="mt-5 px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 text-white
                   text-sm font-medium disabled:opacity-50 flex items-center gap-2">
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        Change password
      </button>
    </form>
  );
}

export default function Security() {
  return (
    <div className="p-6 max-w-2xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-white tracking-tight">Security</h1>
        <p className="text-sm text-slate-400 mt-1">
          Controls access to this app on this machine.
        </p>
      </div>

      <TwoFactorSettings />
      <ChangePassword />

      <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-5">
        <h4 className="text-sm font-medium text-slate-300 mb-2">What this does and does not protect</h4>
        <ul className="text-xs text-slate-500 space-y-1.5 leading-relaxed">
          <li>• Guards the app's API, so the data cannot be read by reloading, calling the API directly, or from another browser.</li>
          <li>• Does <strong className="text-slate-400">not</strong> encrypt the data on disk — anyone with access to this machine's files can read <code>data/</code> regardless.</li>
          <li>• Trading continues while you are signed out. Locking the screen never pauses the bot.</li>
          <li>• Lost your password and backup codes? Delete <code>data/auth.json</code> to reset. Your trading data is untouched.</li>
        </ul>
      </div>
    </div>
  );
}
