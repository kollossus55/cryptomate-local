// React side of the all-time drawdown. The rules are in allTimeLogic.js.
import { useV6Query } from './useV6';
import { allTimeLabel, deriveAllTime } from './allTimeLogic';

export { allTimeLabel, deriveAllTime };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function useAllTimeDrawdown(status) {
  const needsCurve = !!status && !isNum(status.risk?.allTime?.drawdownPct);
  const curve = useV6Query('equityCurve', { range: 'all' }, { enabled: needsCurve });
  return {
    ...deriveAllTime(status, curve.data),
    loading: needsCurve && curve.isPending,
  };
}
