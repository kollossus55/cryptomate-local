/**
 * Lock screen.
 *
 * Two modes, decided by the server rather than the client:
 *  - setup: no password exists yet, so create one
 *  - login: a password exists, so enter it
 *
 * Matches the app's own palette (slate base, indigo-to-purple accent) so it
 * reads as part of CryptoMate rather than a bolted-on gate.
 */

import React, { useState, useRef, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Lock, ShieldCheck, AlertCircle, Loader2, KeyRound } from 'lucide-react';

export default function LockScreen({ mode, onUnlocked, onCancel }) {
  const isSetup = mode === 'setup';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  // Second factor, once the password has been accepted.
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');
  const codeRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { if (challenge) codeRef.current?.focus(); }, [challenge]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    if (isSetup) {
      if (password.length < 8) return setError('Password must be at least 8 characters.');
      if (password !== confirm) return setError('The two passwords do not match.');
    } else if (!password) {
      return setError('Enter your password.');
    }

    setBusy(true);
    try {
      if (isSetup) {
        await base44.auth.setup(password);
        onUnlocked();
        return;
      }

      const result = await base44.auth.login(password);

      // A correct password alone is not a session when 2FA is on.
      if (result?.mfaRequired) {
        setChallenge(result.challenge);
        setPassword('');
        return;
      }

      onUnlocked();
    } catch (err) {
      setError(err.message || 'Could not sign in.');
      setPassword('');
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e) => {
    e.preventDefault();
    setError(null);
    if (!code.trim()) return setError('Enter the code from your authenticator app.');

    setBusy(true);
    try {
      await base44.auth.verifyMfa(challenge, code.trim());
      onUnlocked();
    } catch (err) {
      setError(err.message || 'Could not verify that code.');
      setCode('');
      // The challenge is consumed on a failed attempt, so go back to the
      // password rather than letting the user retry against a dead challenge.
      if (/expired|sign-in/i.test(err.message || '')) setChallenge(null);
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  // ── Second factor ───────────────────────────────────────────────────────
  if (challenge) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-slate-950 to-slate-900 px-4">
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center mb-8">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mb-4">
              <KeyRound className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-2xl font-semibold text-white tracking-tight">Two-factor</h1>
            <p className="text-sm text-slate-400 mt-1">Enter the code from your authenticator app</p>
          </div>

          <form onSubmit={submitCode} className="bg-slate-900/80 border border-slate-800 rounded-xl p-6 backdrop-blur">
            <input
              ref={codeRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-3 text-white text-center
                         text-xl tracking-[0.3em] placeholder-slate-700 focus:outline-none focus:ring-2
                         focus:ring-indigo-500 focus:border-transparent disabled:opacity-50"
              placeholder="000000"
            />

            {error && (
              <div className="flex items-start gap-2 mt-4 text-sm text-red-400">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full mt-6 bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-lg
                         py-2.5 font-medium hover:opacity-90 transition disabled:opacity-50
                         flex items-center justify-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Verify
            </button>

            <p className="text-xs text-slate-500 mt-4 text-center">
              Lost your phone? Enter one of your backup codes instead.
            </p>
          </form>

          <button
            onClick={() => { setChallenge(null); setCode(''); setError(null); }}
            className="w-full mt-4 text-xs text-slate-500 hover:text-slate-300"
          >
            Start again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-slate-950 to-slate-900 px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mb-4">
            {isSetup ? <ShieldCheck className="w-7 h-7 text-white" /> : <Lock className="w-7 h-7 text-white" />}
          </div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">CryptoMate</h1>
          <p className="text-sm text-slate-400 mt-1">
            {isSetup ? 'Choose a password to protect this app' : 'Enter your password to continue'}
          </p>
        </div>

        <form
          onSubmit={submit}
          className="bg-slate-900/80 border border-slate-800 rounded-xl p-6 backdrop-blur"
        >
          <label className="block text-xs uppercase tracking-wide text-slate-500 mb-2">
            {isSetup ? 'New password' : 'Password'}
          </label>
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            disabled={busy}
            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-white
                       placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500
                       focus:border-transparent disabled:opacity-50"
            placeholder={isSetup ? 'At least 8 characters' : '••••••••'}
          />

          {isSetup && (
            <>
              <label className="block text-xs uppercase tracking-wide text-slate-500 mt-4 mb-2">
                Confirm password
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                disabled={busy}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-white
                           placeholder-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500
                           focus:border-transparent disabled:opacity-50"
                placeholder="Type it again"
              />
            </>
          )}

          {error && (
            <div className="flex items-start gap-2 mt-4 text-sm text-red-400">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full mt-6 bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-lg
                       py-2.5 font-medium hover:opacity-90 transition disabled:opacity-50
                       flex items-center justify-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {isSetup ? 'Set password and continue' : 'Unlock'}
          </button>

          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="w-full mt-3 text-xs text-slate-500 hover:text-slate-300"
            >
              Back
            </button>
          )}

          {isSetup && (
            <p className="text-xs text-slate-500 mt-4 leading-relaxed">
              There is no recovery for this password. If you lose it, delete
              <code className="mx-1 text-slate-400">data/auth.json</code>
              and you will be asked to set a new one — your trading data is untouched.
            </p>
          )}
        </form>

        {/* Said plainly, because the opposite assumption would be dangerous. */}
        <p className="text-xs text-slate-600 text-center mt-6 leading-relaxed">
          Trading continues while you are signed out.
          <br />
          Locking the screen does not pause the bot.
        </p>
      </div>
    </div>
  );
}
