/**
 * Simple, conservative long-only position sizing for Fintual (manual execution).
 *
 * Deliberately NOT Kelly/leverage — sober expectations: a small base allocation
 * scaled by signal confidence, hard-capped as a fraction of bankroll, floored at
 * a minimum order size. The user executes manually, so this is a *suggestion*.
 */
export interface SizingConfig {
  bankrollUsd: number;
  /** Base allocation per trade as a fraction of bankroll (e.g. 0.05 = 5%). */
  basePct: number;
  /** Hard cap per position as a fraction of bankroll (e.g. 0.10 = 10%). */
  maxPct: number;
  /** Minimum order size in USD (avoid dust orders). */
  minUsd: number;
}

export const DEFAULT_SIZING: SizingConfig = {
  bankrollUsd: parseFloat(process.env['INITIAL_BANKROLL'] ?? '10000'),
  basePct: 0.05,
  maxPct: 0.10,
  minUsd: 50,
};

/**
 * Suggested USD amount for a trade given the signal confidence (0–1).
 * Confidence 0→base×0.5, 1→base; never exceeds maxPct of bankroll; never below minUsd.
 */
export function sizePosition(confidence: number, cfg: SizingConfig = DEFAULT_SIZING): number {
  const c = Math.max(0, Math.min(1, confidence));
  const scale = 0.5 + 0.5 * c; // 0.5 … 1.0
  const pct = Math.min(cfg.maxPct, cfg.basePct * scale);
  const usd = cfg.bankrollUsd * pct;
  return Math.max(cfg.minUsd, Math.round(usd));
}
