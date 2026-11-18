// Shown by Layout on pages from the old engine (gui-design 8.3).
import React from 'react';
import { Link } from 'react-router-dom';
import { Archive } from 'lucide-react';
import { createPageUrl } from '@/components/utils';

const MESSAGES = {
  default:
    'This belongs to the old engine, not V6. Nothing here changes V6. Measured net of costs, that engine ' +
    'lost money in 9 of 9 ninety-day windows on 4h and 8 of 9 on 1h. Scores here are not odds.',
  StrategyLab: 'Separate paper experiment. Not V6. Its two rules are not clean on the holdout period.',
};

export default function LegacyBanner({ page }) {
  return (
    <div className="flex items-start gap-3 border-b border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-300">
      <Archive className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="mr-2 font-semibold">LEGACY PAGE.</span>
        {MESSAGES[page] ?? MESSAGES.default}
      </p>
      <Link to={createPageUrl('MissionControl')} className="shrink-0 text-xs underline underline-offset-2">
        Go to V6
      </Link>
    </div>
  );
}
