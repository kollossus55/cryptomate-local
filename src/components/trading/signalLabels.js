// Graded, human-readable labels for the indicator-derived signal shown on the
// Trading page. The underlying recommendation stays buy / sell / hold; the grade
// is derived from the confidence score so the label reflects the signal's
// score, not just its direction. A high score is not better odds: in the audit,
// entries at score 95 were the worst group (n=261, 25.7% wins, mean -1.01% net).
export function getSignalLabel(recommendation, confidence) {
  const c = Number(confidence) || 0;

  if (recommendation === "buy") {
    if (c >= 88) return "Buy (high score)";
    if (c >= 78) return "Buy (raised score)";
    return "Buy";
  }

  if (recommendation === "sell") {
    if (c <= 32) return "Sell (low score)";
    if (c <= 42) return "Sell (lowered score)";
    return "Sell";
  }

  return "Hold";
}