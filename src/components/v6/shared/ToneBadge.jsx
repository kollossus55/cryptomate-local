// Semantic tones from gui-design 3. A state always carries an icon and text, never
// colour alone. Cash is slate, never red; holding is indigo, never green.
import React from 'react';
import { Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export const TONE = {
  slate: {
    badge: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
    card: 'border-slate-700 bg-slate-900/60',
    icon: 'text-slate-300',
  },
  indigo: {
    badge: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
    card: 'border-indigo-500/40 bg-indigo-500/10',
    icon: 'text-indigo-300',
  },
  emerald: {
    badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    card: 'border-emerald-500/40 bg-emerald-500/10',
    icon: 'text-emerald-300',
  },
  amber: {
    badge: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
    card: 'border-amber-500/40 bg-amber-500/10',
    icon: 'text-amber-300',
  },
  red: {
    badge: 'bg-red-500/20 text-red-300 border-red-500/30',
    card: 'border-red-500/50 bg-red-500/10',
    icon: 'text-red-300',
  },
};

export const toneOf = (tone) => TONE[tone] ?? TONE.slate;

export function ToneBadge({ tone = 'slate', icon: Icon, children, className = '' }) {
  return (
    <Badge variant="outline" className={`gap-1 font-medium ${toneOf(tone).badge} ${className}`}>
      {Icon && <Icon className="h-3 w-3" aria-hidden="true" />}
      {children}
    </Badge>
  );
}

/** Shown beside numbers that may be out of date: engine down, or a refetch failed. */
export function StaleBadge({ label = 'stale' }) {
  return (
    <ToneBadge tone="amber" icon={Clock}>
      {label}
    </ToneBadge>
  );
}
