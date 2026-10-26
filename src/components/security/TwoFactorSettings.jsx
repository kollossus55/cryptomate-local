/**
 * Two-factor setup and management.
 *
 * Three states: not enabled (offer setup), enrolling (QR + confirm), enabled
 * (status + disable). Backup codes are shown exactly once, immediately after
 * enrolment — they are stored hashed, so they cannot be shown again.
 */

import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  ShieldCheck, ShieldOff, AlertCircle, Loader2, Copy, Check, KeyRound, Download,
} from 'lucide-react';

export default function TwoFactorSettings() {
  const [status, setStatus] = useState(null);
  const [enrolment, setEnrolment] = useState(null);   // { token, secret, uri, qr }
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [showDisable, setShowDisable] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = async () => {
    try {
      setStatus(await base44.auth.mfaStatus());
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => { refresh(); }, []);

  const begin = async () => {
    setError(null); setBusy(true);
    try {
      setEnrolment(await base44.auth.beginMfaEnrolment());
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  const confirm = async (e) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const result = await base44.auth.confirmMfaEnrolment(enrolment.token, code.trim());
      setBackupCodes(result.backupCodes);
      setEnrolment(null);
      setCode('');
      await refresh();
    } catch (err) {
      setError(err.message);
      setCode('');
    } finally { setBusy(false); }
  };

  const disable = async (e) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await base44.auth.disableMfa(disablePassword);
      setDisablePassword('');
      setShowDisable(false);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  const copyCodes = () => {
    navigator.clipboard?.writeText(backupCodes.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadCodes = () => {
    const blob = new Blob(
      [`CryptoMate backup codes\nGenerated ${new Date().toISOString()}\n\n${backupCodes.join('\n')}\n\nEach code works once.\n`],
      { type: 'text/plain' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cryptomate-backup-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const card = 'bg-slate-900/80 border border-slate-800 rounded-xl p-6';

  // ── Backup codes, shown once ──────────────────────────────────────────────
  if (backupCodes) {
    return (
      <div className={card}>
        <div className="flex items-center gap-3 mb-4">
          <ShieldCheck className="w-5 h-5 text-emerald-400" />
          <h3 className="text-white font-medium">Two-factor is on. Save these backup codes.</h3>
        </div>

        <p className="text-sm text-slate-400 mb-4 leading-relaxed">
          Each code works once, and they are the only way in if you lose your phone.
          They are stored hashed, so <strong className="text-slate-200">this is the only
          time they can be shown</strong>.
        </p>

        <div className="grid grid-cols-2 gap-2 font-mono text-sm bg-slate-950 border border-slate-800 rounded-lg p-4 mb-4">
          {backupCodes.map((c) => <div key={c} className="text-slate-200">{c}</div>)}
        </div>

        <div className="flex gap-2">
          <button onClick={copyCodes}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700">
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button onClick={downloadCodes}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700">
            <Download className="w-4 h-4" /> Download
          </button>
          <button onClick={() => setBackupCodes(null)}
            className="ml-auto px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 text-white text-sm">
            I've saved them
          </button>
        </div>
      </div>
    );
  }

  // ── Enrolling ─────────────────────────────────────────────────────────────
  if (enrolment) {
    return (
      <div className={card}>
        <h3 className="text-white font-medium mb-1">Scan this with your authenticator app</h3>
        <p className="text-sm text-slate-400 mb-5">
          Google Authenticator, Authy, 1Password, Bitwarden — any of them.
        </p>

        {enrolment.qr && (
          <div className="flex justify-center mb-5">
            <img src={enrolment.qr} alt="Two-factor QR code" className="rounded-lg bg-white p-2" width={200} height={200} />
          </div>
        )}

        <div className="mb-5">
          <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">Or enter this key by hand</p>
          <code className="block bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-300 text-sm break-all font-mono">
            {enrolment.secret}
          </code>
        </div>

        <form onSubmit={confirm}>
          <label className="block text-xs uppercase tracking-wide text-slate-500 mb-2">
            Then enter the 6-digit code it shows
          </label>
          <input
            type="text" inputMode="numeric" autoComplete="one-time-code"
            value={code} onChange={(e) => setCode(e.target.value)} disabled={busy}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-3 text-white text-center
                       text-xl tracking-[0.3em] placeholder-slate-700 focus:outline-none focus:ring-2
                       focus:ring-indigo-500 disabled:opacity-50"
            placeholder="000000"
          />

          {error && (
            <div className="flex items-start gap-2 mt-4 text-sm text-red-400">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>{error}</span>
            </div>
          )}

          <div className="flex gap-2 mt-5">
            <button type="button" onClick={() => { setEnrolment(null); setError(null); }}
              className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700">
              Cancel
            </button>
            <button type="submit" disabled={busy}
              className="flex-1 px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 text-white
                         text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Turn on two-factor
            </button>
          </div>
        </form>
      </div>
    );
  }

  // ── Status ────────────────────────────────────────────────────────────────
  return (
    <div className={card}>
      <div className="flex items-start gap-3 mb-4">
        {status?.enabled
          ? <ShieldCheck className="w-5 h-5 text-emerald-400 mt-0.5" />
          : <ShieldOff className="w-5 h-5 text-slate-500 mt-0.5" />}
        <div>
          <h3 className="text-white font-medium">Two-factor authentication</h3>
          <p className="text-sm text-slate-400 mt-1">
            {status?.enabled
              ? 'A code from your authenticator app is required to sign in.'
              : 'Sign-in currently needs only your password.'}
          </p>
        </div>
      </div>

      {status?.enabled && (
        <p className="text-xs text-slate-500 mb-4">
          {status.backupCodesRemaining} backup code{status.backupCodesRemaining === 1 ? '' : 's'} remaining.
          {status.backupCodesRemaining <= 2 && (
            <span className="text-amber-400"> Running low — turn 2FA off and on again to get a fresh set.</span>
          )}
        </p>
      )}

      {error && (
        <div className="flex items-start gap-2 mb-4 text-sm text-red-400">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /><span>{error}</span>
        </div>
      )}

      {!status?.enabled && (
        <button onClick={begin} disabled={busy}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600
                     text-white text-sm font-medium disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
          Set up two-factor
        </button>
      )}

      {status?.enabled && !showDisable && (
        <button onClick={() => setShowDisable(true)}
          className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700">
          Turn off
        </button>
      )}

      {status?.enabled && showDisable && (
        <form onSubmit={disable} className="mt-2">
          {/* Password required: someone at an unlocked screen should not be
              able to remove the second factor. */}
          <label className="block text-xs uppercase tracking-wide text-slate-500 mb-2">
            Confirm your password to turn it off
          </label>
          <input
            type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)}
            disabled={busy} autoComplete="current-password"
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-white
                       focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
            placeholder="••••••••"
          />
          <div className="flex gap-2 mt-3">
            <button type="button" onClick={() => { setShowDisable(false); setDisablePassword(''); setError(null); }}
              className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700">
              Cancel
            </button>
            <button type="submit" disabled={busy}
              className="px-4 py-2 rounded-lg bg-red-600/90 text-white text-sm font-medium disabled:opacity-50
                         flex items-center gap-2">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Turn off two-factor
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
