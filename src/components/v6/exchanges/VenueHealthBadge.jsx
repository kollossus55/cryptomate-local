import React from 'react';
import { Ban, CheckCircle2, HelpCircle, Hourglass, MinusCircle, RefreshCw, Timer, XCircle } from 'lucide-react';
import { ToneBadge } from '@/components/v6/shared';

const HEALTH = {
  ok: { tone: 'emerald', icon: CheckCircle2, label: 'OK' },
  slow: { tone: 'amber', icon: Timer, label: 'Slow' },
  recovering: { tone: 'amber', icon: RefreshCw, label: 'Recovering' },
  rate_limited: { tone: 'amber', icon: Hourglass, label: 'Rate limited' },
  unknown: { tone: 'slate', icon: HelpCircle, label: 'Unknown' },
  disabled: { tone: 'slate', icon: MinusCircle, label: 'Off' },
  blocked: { tone: 'red', icon: Ban, label: 'Blocked' },
  error: { tone: 'red', icon: XCircle, label: 'Error' },
};

export default function VenueHealthBadge({ state, retryInMs }) {
  const { tone, icon, label } = HEALTH[state] ?? HEALTH.unknown;
  const retry = retryInMs > 0 && ['error', 'rate_limited', 'blocked'].includes(state)
    ? `, retry in ${Math.ceil(retryInMs / 1000)} s`
    : '';
  return <ToneBadge tone={tone} icon={icon} className="whitespace-nowrap">{label}{retry}</ToneBadge>;
}
