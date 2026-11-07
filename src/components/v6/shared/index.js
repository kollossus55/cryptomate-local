// Shared V6 UI. Import from '@/components/v6/shared'. Usage notes: docs/rebuild/gui-1.md.
export {
  V6Refusal,
  callV6,
  useV6Query,
  useV6Status,
  useV6Mutation,
  describeV6Error,
  V6_POLL_MS,
  NEXT_TICK_NOTE,
} from './useV6';
export * from './format';
export { default as PaperBanner, usePaperTitle } from './PaperBanner';
export { default as PageHeader, LastEngineRun } from './PageHeader';
export { TONE, toneOf, ToneBadge, StaleBadge } from './ToneBadge';
export { V6Card, SkeletonRows, EmptyNote, InlineError, PageError, StaleSince, QueryState } from './StateCard';
export { default as CheckIcon } from './CheckIcon';
export { default as StatTile } from './StatTile';
export { SERIES_COLORS, AXIS, ChartLegend, ChartTooltip, ChartFrame } from './ChartFrame';
export { default as TypedConfirmDialog } from './TypedConfirmDialog';
export { default as SegmentedTabs } from './SegmentedTabs';
export { useAllTimeDrawdown, deriveAllTime, allTimeLabel } from './useAllTimeDrawdown';
export { default as QuarantineCard } from './QuarantineCard';
