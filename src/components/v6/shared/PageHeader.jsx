// Title block for every V6 page: PAPER tag, subtitle, "Last engine run", document title.
// The tag is a second paper marker that does not depend on Layout mounting the banner.
import React from 'react';
import { FlaskConical } from 'lucide-react';
import { usePaperTitle } from './PaperBanner';
import { useV6Status } from './useV6';
import { ToneBadge } from './ToneBadge';
import { ago } from './format';

export function LastEngineRun() {
  const { data } = useV6Status();
  if (!data?.engine) return null;
  return (
    <p className="text-xs text-slate-400">
      {data.engine.lastTickAt ? `Last engine run ${ago(data.engine.lastTickAt)}` : 'The engine has not run yet'}
    </p>
  );
}

export default function PageHeader({ title, icon: Icon, subtitle, children }) {
  usePaperTitle(title);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold text-slate-100">
          {Icon && <Icon className="h-6 w-6" aria-hidden="true" />}
          {title}
          <ToneBadge tone="amber" icon={FlaskConical}>
            PAPER
          </ToneBadge>
        </h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-slate-400">{subtitle}</p>}
      </div>
      <div className="flex flex-col items-end gap-2">
        <LastEngineRun />
        {children}
      </div>
    </div>
  );
}
