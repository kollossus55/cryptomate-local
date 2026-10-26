/**
 * Local auth context.
 *
 * Replaces the Base44 OAuth flow with a password lock enforced by the local
 * server. The contract is unchanged — same hook name, same fields — so App.jsx
 * and NavigationTracker.jsx work without edits.
 *
 * The lock gates the HTTP API. It does NOT stop the bot: the scheduler and
 * backend functions run in the server process and never look at a session, so
 * positions keep being managed while the screen is locked.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import LockScreen from '@/lib/LockScreen';
import Home from '@/pages/Home';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [serverUnreachable, setServerUnreachable] = useState(false);

  // Signed out, the landing page is shown first; the lock screen appears only
  // once "Sign In / Sign Up" is pressed. First run is the exception — there is
  // nothing to sign into until a password exists, so setup opens immediately.
  const [showLock, setShowLock] = useState(false);

  // Kept so App.jsx's existing loading branch behaves as before.
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(true);
  const [appPublicSettings, setAppPublicSettings] = useState(null);

  const check = useCallback(async () => {
    try {
      const status = await base44.auth.status();
      setServerUnreachable(false);
      setNeedsSetup(!status.configured);

      if (status.authenticated) {
        setUser(await base44.auth.me());
        setIsAuthenticated(true);
      } else {
        setIsAuthenticated(false);
      }
    } catch (err) {
      // Reaching here means the server is down, not that you are signed out —
      // showing a password prompt would be actively misleading.
      setServerUnreachable(true);
      setAuthError(err.message || 'Could not reach the local server');
    } finally {
      setIsLoadingAuth(false);
      setAppPublicSettings({ id: 'cryptomate-local', public_settings: {} });
      setIsLoadingPublicSettings(false);
    }
  }, []);

  useEffect(() => { check(); }, [check]);

  // Home.jsx calls base44.auth.redirectToLogin(), which raises this rather than
  // navigating — so the landing page needs no changes to work locally.
  useEffect(() => {
    const open = () => setShowLock(true);
    window.addEventListener('cryptomate:show-lock', open);
    return () => window.removeEventListener('cryptomate:show-lock', open);
  }, []);

  const logout = async () => { await base44.auth.logout(); };
  const navigateToLogin = () => window.location.reload();

  if (isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-slate-950">
        <div className="w-8 h-8 border-4 border-slate-800 border-t-indigo-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (serverUnreachable) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-slate-950 px-4">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold text-white mb-3">Can't reach the local server</h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            The app is running but the server behind it is not responding. Start it
            with <code className="text-slate-300">npm start</code> and reload this page.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-6 px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    // No password yet: go straight to setup, since there is nothing to sign
    // into and a landing page offering "Sign In" would be a dead end.
    if (needsSetup || showLock) {
      return (
        <LockScreen
          mode={needsSetup ? 'setup' : 'login'}
          onUnlocked={async () => { setShowLock(false); await check(); }}
          onCancel={needsSetup ? null : () => setShowLock(false)}
        />
      );
    }

    // Otherwise the landing page, exactly as it was.
    return <Home />;
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated,
        isLoadingAuth,
        isLoadingPublicSettings,
        authError,
        appPublicSettings,
        logout,
        navigateToLogin,
        setUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
