import { logger } from '../shared/logger';
import { clamp, round } from '../shared/utils';
import { KellyInput, KellyResult } from './types';

/**
 * Kelly Criterion position sizing.
 * f* = (p * b - q) / b
 * where p = win probability, q = 1 - p, b = net odds
 */
export function calculateKelly(input: KellyInput): KellyResult {
  const { winProbability: p, netOdds: b, bankroll, kellyFraction, maxPositionPct } = input;
  const q = 1 - p;

  if (b <= 0) {
    logger.warn('Kelly: invalid net odds', { b });
    return { fullKellyFraction: 0, fractionalKellyFraction: 0, recommendedSizeUsd: 0, cappedByHardLimit: false };
  }

  // Full Kelly fraction
  const fullKelly = (p * b - q) / b;

  if (fullKelly <= 0) {
    return { fullKellyFraction: fullKelly, fractionalKellyFraction: 0, recommendedSizeUsd: 0, cappedByHardLimit: false };
  }

  // Apply fractional Kelly
  const fractionalKelly = fullKelly * kellyFraction;

  // Apply hard cap (e.g., 5% of bankroll)
  const cappedFraction = Math.min(fractionalKelly, maxPositionPct);
  const cappedByHardLimit = cappedFraction < fractionalKelly;

  const recommendedSizeUsd = round(bankroll * cappedFraction, 2);

  return {
    fullKellyFraction: round(fullKelly),
    fractionalKellyFraction: round(fractionalKelly),
    recommendedSizeUsd,
    cappedByHardLimit,
  };
}

/**
 * Calculate net odds from a market price.
 * If market price is 0.40, decimal odds = 1/0.40 = 2.5, net odds b = 1.5
 */
export function netOddsFromPrice(price: number): number {
  if (price <= 0 || price >= 1) return 0;
  return (1 / price) - 1;
}

/**
 * Calculate Value at Risk (95% confidence).
 * VaR = position_size * loss_per_unit * z_score
 */
export function calculateVaR(
  positionSize: number,
  winProbability: number,
  zScore95: number = 1.645
): number {
  const lossPerUnit = 1 - winProbability;
  return round(positionSize * lossPerUnit * zScore95, 2);
}
