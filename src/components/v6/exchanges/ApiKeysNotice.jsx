// Deliberately not part of the venue table, and shows no key data: this page never reads
// ExchangeConnection, and V6 has no use for keys.
import React from 'react';
import { Link } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { createPageUrl } from '@/components/utils';

export default function ApiKeysNotice() {
  return (
    <section aria-label="Exchange API keys" className="rounded-lg border border-dashed border-slate-700 p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-300">
        <KeyRound className="h-4 w-4" aria-hidden="true" />
        Exchange API keys: LIVE TRADING ONLY, NOT USED BY V6
      </h2>
      <p className="mt-1 text-sm text-slate-400">
        Keys are stored for the old engine's live trading. V6 never reads them and does not need
        them. Adding keys here does not improve V6.
      </p>
      <Link
        to={createPageUrl('ExchangeSettings')}
        className="mt-2 inline-block text-sm text-slate-300 underline underline-offset-2 hover:text-white"
      >
        Manage API keys (legacy)
      </Link>
    </section>
  );
}
