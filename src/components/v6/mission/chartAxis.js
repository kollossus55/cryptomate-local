// Y axis for the equity vs BTC chart. Pure, so it can be tested without rendering.

/** Evenly spaced ticks. Every step divides 100, so the start line always falls on a tick. */
export function axisFor(points) {
  const values = points.flatMap((p) => [p.equityIndex, p.btcIndex]).filter((v) => Number.isFinite(v));
  const min = Math.min(...values, 100);
  const max = Math.max(...values, 100);
  const pad = Math.max((max - min) * 0.08, 0.5);
  const span = max - min + 2 * pad;
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].find((s) => span / s <= 6) ?? 2000;
  const lo = Math.floor((min - pad) / step) * step;
  const hi = Math.ceil((max + pad) / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  return { domain: [lo, hi], ticks };
}
