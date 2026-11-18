// Mounted by Layout on every page except Home (gui-design 4.1). Sticky, not dismissable.
// The first row is static because it is a fact about the code: it must render even when
// the API is down. The rows below stop that fact from over-claiming about the old engine.
import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, FlaskConical, HelpCircle } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { createPageUrl } from '@/components/utils';
import { useV6Status } from './useV6';

function WhyPaper() {
  return (
    <Popover>
      <PopoverTrigger className="inline-flex shrink-0 items-center gap-1 text-xs underline underline-offset-2 hover:text-amber-100">
        <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" /> Why?
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 border-slate-700 bg-slate-900 text-sm text-slate-300">
        <p>
          V6 reads public market data only. It holds no API keys and calls no private exchange
          endpoint, so it has no route to a real order.
        </p>
        <p className="mt-2">
          Fills are simulated. Paper results leave out things real trading has, so they are not a
          forecast of real results.
        </p>
        <p className="mt-2">Changing this takes a deliberate code or config change by a person. No switch in this app does it.</p>
      </PopoverContent>
    </Popover>
  );
}

export default function PaperBanner() {
  const status = useV6Status();
  const legacy = status.data?.legacy;
  // Never assume "off" from silence: a failed read or a null field is its own row.
  const legacyUnknown = status.isError || (status.isSuccess && !legacy);

  return (
    <div role="region" aria-label="Paper mode notice" className="sticky top-16 z-20 md:top-0">
      {/* Opaque base under the 15% amber wash, so scrolled content cannot show through. */}
      <div className="border-b border-amber-500/40 bg-slate-950 text-amber-200">
        <div className="flex items-center gap-3 bg-amber-500/15 px-4 py-2 text-sm">
          <FlaskConical className="h-5 w-5 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1">
            <span className="mr-2 font-bold tracking-wide">PAPER MODE</span>
            V6 uses virtual money. It has no way to place real orders.
          </p>
          <WhyPaper />
        </div>
      </div>

      {legacy?.liveTradingEnabled === true && (
        <div className="flex items-center gap-3 bg-red-600 px-4 py-2 text-sm text-white">
          <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1">
            <span className="mr-2 font-bold">LEGACY LIVE TRADING IS ON.</span>
            The old engine can place real orders on your exchange account. This is separate from V6.
          </p>
          <Link to={createPageUrl('AutoTrading')} className="shrink-0 text-xs underline underline-offset-2">
            Review
          </Link>
        </div>
      )}

      {legacy?.autoTradingEnabled === true && (
        <div className="border-b border-amber-500/40 bg-slate-950 text-xs text-amber-200">
          <div className="bg-amber-500/15 px-4 py-1.5">The old auto-trader is also running on its own paper account.</div>
        </div>
      )}

      {legacyUnknown && (
        <div className="border-b border-slate-700 bg-slate-800 px-4 py-1.5 text-xs text-slate-300">
          Could not read the old engine's live setting.
        </div>
      )}
    </div>
  );
}

/** Sets `PAPER - <page> - CryptoMate` while a V6 page is open (gui-design 4.1). */
export function usePaperTitle(page) {
  useEffect(() => {
    const previous = document.title;
    document.title = `PAPER - ${page} - CryptoMate`;
    return () => {
      document.title = previous;
    };
  }, [page]);
}
