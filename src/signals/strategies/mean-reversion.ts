/**
 * src/signals/strategies/mean-reversion.ts
 *
 * Strict mean-reversion SignalEngine.
 *
 * BUY  : RSI < 30 AND price <= lower Bollinger Band (20-period, 2σ)
 * SELL : RSI > 50 OR  price >= Bollinger middle band (reversion complete)
 * HOLD : everything else
 *
 * Confidence and strength scale with how deep the oversold condition is:
 *   - lower RSI → higher score
 *   - further below lower BB → higher score
 *   - both scores averaged, then penalised for short bar series
 *
 * Design constraints:
 *   - NEVER throws; insufficient data returns a low-confidence hold.
 *   - NO lookahead: only uses the bars array passed in.
 *   - No network calls; no side-effects.
 */

import { SignalEngine } from '../index';
import { PriceBar, Signal } from '../../shared/types';
import { BollingerBands, RSI } from 'technicalindicators';

// ─── Constants ────────────────────────────────────────────────────────────────

/** BB period and standard deviation per the task spec. */
const BB_PERIOD = 20;
const BB_STD_DEV = 2;

/** RSI period (standard 14-bar). */
const RSI_PERIOD = 14;

/**
 * Minimum bars needed to compute both indicators.
 * BB needs BB_PERIOD bars; RSI needs RSI_PERIOD+1 bars.
 */
const MIN_BARS_REQUIRED = Math.max(BB_PERIOD, RSI_PERIOD + 1);

/**
 * Bar count at which confidence receives no data-volume penalty.
 * Below this threshold confidence is scaled down linearly to 0.4.
 */
const MIN_BARS_FULL_CONFIDENCE = 60;

// ─── BUY thresholds ───────────────────────────────────────────────────────────

/** RSI must be strictly below this to qualify as deeply oversold. */
const RSI_BUY_THRESHOLD = 30;

/** RSI must exceed this (or price must reach middle band) to trigger exit. */
const RSI_SELL_THRESHOLD = 50;

// ─── MeanReversionEngine ─────────────────────────────────────────────────────

export class MeanReversionEngine implements SignalEngine {
  async evaluate(ticker: string, bars: PriceBar[]): Promise<Signal> {
    if (bars.length < MIN_BARS_REQUIRED) {
      return insufficientDataHold(
        ticker,
        `need at least ${MIN_BARS_REQUIRED} bars, got ${bars.length}`
      );
    }

    const closes = bars.map((b) => b.close);
    const currentPrice = closes[closes.length - 1]!;

    // ── Compute indicators ───────────────────────────────────────────────────

    const rsi = computeRsi(closes);
    const bb = computeBb(closes);

    if (rsi === null || bb === null) {
      return insufficientDataHold(ticker, 'indicator computation returned null');
    }

    const dataFactor = dataPenaltyFactor(bars.length);

    // ── BUY condition: both gates must be open ───────────────────────────────
    //   1. RSI < 30  (deeply oversold)
    //   2. price <= lower Bollinger Band

    const rsiOversold = rsi < RSI_BUY_THRESHOLD;
    const belowLowerBand = currentPrice <= bb.lower;

    if (rsiOversold && belowLowerBand) {
      // Strength: how deep below RSI=30 and how far below the lower band.
      // rsiScore: RSI=30 → 0, RSI=0 → 1
      const rsiScore = clamp((RSI_BUY_THRESHOLD - rsi) / RSI_BUY_THRESHOLD);

      // bbScore: at the band → 0; priceDrop further below → scales up.
      // Normalise against 5% of middle as a reference depth.
      const bbGap = bb.lower - currentPrice; // positive: price is below lower band
      const bbRef = bb.middle * 0.05;
      const bbScore = bbRef > 0 ? clamp(bbGap / bbRef) : (bbGap > 0 ? 1 : 0);

      const rawStrength = (rsiScore + bbScore) / 2;
      const strength = round(clamp(rawStrength));
      const confidence = round(strength * dataFactor);

      return {
        ticker,
        action: 'buy',
        strength,
        confidence,
        reasons: [
          `RSI=${rsi.toFixed(1)} (oversold, threshold <${RSI_BUY_THRESHOLD})`,
          `price ${currentPrice.toFixed(4)} at/below lower BB ${bb.lower.toFixed(4)}`,
        ],
        timestamp: new Date(),
      };
    }

    // ── SELL condition: either gate triggers reversion ───────────────────────
    //   1. RSI > 50  (momentum recovered to neutral)
    //   2. price >= middle Bollinger Band (mean restored)

    const rsiReverted = rsi > RSI_SELL_THRESHOLD;
    const aboveMiddleBand = currentPrice >= bb.middle;

    if (rsiReverted || aboveMiddleBand) {
      const exitReasons: string[] = [];

      if (rsiReverted) {
        exitReasons.push(`RSI=${rsi.toFixed(1)} > ${RSI_SELL_THRESHOLD} (reverted)`);
      }
      if (aboveMiddleBand) {
        exitReasons.push(
          `price ${currentPrice.toFixed(4)} >= middle BB ${bb.middle.toFixed(4)} (mean restored)`
        );
      }

      // Strength of reversion signal: how far above threshold.
      const rsiRevertScore = rsiReverted ? clamp((rsi - RSI_SELL_THRESHOLD) / (100 - RSI_SELL_THRESHOLD)) : 0;
      const bbRevertScore = aboveMiddleBand
        ? clamp((currentPrice - bb.middle) / (bb.upper - bb.middle + 1e-9))
        : 0;

      const strength = round(clamp(Math.max(rsiRevertScore, bbRevertScore)));
      const confidence = round(strength * dataFactor);

      return {
        ticker,
        action: 'sell',
        strength,
        confidence,
        reasons: exitReasons,
        timestamp: new Date(),
      };
    }

    // ── HOLD: no condition met ───────────────────────────────────────────────

    return {
      ticker,
      action: 'hold',
      strength: 0,
      confidence: 0,
      reasons: [
        `RSI=${rsi.toFixed(1)} (between ${RSI_BUY_THRESHOLD} and ${RSI_SELL_THRESHOLD})`,
        `price ${currentPrice.toFixed(4)} between BB bands (lower=${bb.lower.toFixed(4)}, mid=${bb.middle.toFixed(4)})`,
      ],
      timestamp: new Date(),
    };
  }
}

// ─── Indicator helpers ────────────────────────────────────────────────────────

function computeRsi(closes: number[]): number | null {
  try {
    const values = RSI.calculate({ values: closes, period: RSI_PERIOD });
    if (values.length === 0) return null;
    const last = values[values.length - 1];
    return last !== undefined ? last : null;
  } catch {
    return null;
  }
}

function computeBb(closes: number[]): { upper: number; middle: number; lower: number } | null {
  try {
    const values = BollingerBands.calculate({
      values: closes,
      period: BB_PERIOD,
      stdDev: BB_STD_DEV,
    });
    if (values.length === 0) return null;
    const last = values[values.length - 1];
    if (last === undefined) return null;
    return { upper: last.upper, middle: last.middle, lower: last.lower };
  } catch {
    return null;
  }
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

/**
 * Data-volume penalty: returns 1.0 for long series, linearly scales down
 * to 0.4 for the minimum required bar count.
 */
function dataPenaltyFactor(barCount: number): number {
  if (barCount >= MIN_BARS_FULL_CONFIDENCE) return 1.0;
  const ratio =
    (barCount - MIN_BARS_REQUIRED) / (MIN_BARS_FULL_CONFIDENCE - MIN_BARS_REQUIRED);
  return 0.4 + 0.6 * clamp(ratio);
}

/** Clamp a value to [0, 1]. */
function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Round to 3 decimal places. */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function insufficientDataHold(ticker: string, detail: string): Signal {
  return {
    ticker,
    action: 'hold',
    strength: 0,
    confidence: 0,
    reasons: [`insufficient data: ${detail}`],
    timestamp: new Date(),
  };
}
