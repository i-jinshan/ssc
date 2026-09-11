/** 连不中 resetAfter 次后回到 1 倍。resetAfter=3、factor=2 时下一期只能是 1 / 2 / 4，不会到 8。 */
export function nextMartingaleState(
  results: Array<"won" | "lost">,
  enabled: boolean,
  factor: number,
  resetAfter: number,
): { multiplier: number; lossStreak: number } {
  if (!enabled) return { multiplier: 1, lossStreak: 0 };
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const safeReset = Number.isFinite(resetAfter) && resetAfter > 0 ? Math.floor(resetAfter) : 1;
  let lossStreak = 0;
  for (const result of results) {
    if (result === "won") lossStreak = 0;
    else lossStreak += 1;
  }
  const phase = lossStreak % safeReset;
  const multiplier = phase === 0 ? 1 : safeFactor ** phase;
  return { multiplier, lossStreak: phase };
}

export function stakeWithMultiplier(base: number, multiplier: number): number {
  const value = Number(base) * multiplier;
  if (!Number.isFinite(value) || value <= 0) return Math.max(1, Number(base) || 1);
  return Math.round(value * 100) / 100;
}
