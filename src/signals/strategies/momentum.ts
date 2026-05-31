import { PriceBar, Signal } from '../../shared/types';
import { SignalEngine } from '../index';

// ─── Configuration ────────────────────────────────────────────────────────────

export interface MomentumEngineOptions {
  /**
   * Primary lookback in bars (daily close-to-close return window).
   * Default 126 ≈ 6 calendar months of trading days.
   */
  lookback?: number;
  /**
   * Optional secondary lookback for a longer-term return filter.
   * Default 252 ≈ 12 calendar months. Set to 0 to disable.
   */
  longLookback?: number;
  /**
   * Trailing return must exceed this threshold (as a decimal) to emit buy.
   * E.g. 0.05 = price must be at least 5% above the close `lookback` bars ago.
   */
  buyThreshold?: number;
  /**
   * Trailing return below this (inclusive, typically ≤ 0) triggers sell (exit).
   */
  sellThreshold?: number;
  /**
   * Return magnitude that maps to strength/confidence of 1.0 (cap).
   * Returns beyond this are clamped to 1. Default 0.50 (50%).
   */
  returnCap?: number;
  /**
   * Require price to be within this fraction of its highest close in the last
   * `lookback` bars to confirm an uptrend (set to 1 to disable). Default 0.95.
   */
  nearHighFraction?: number;
}

// ─── MomentumEngine ───────────────────────────────────────────────────────────

/**
 * Time-series momentum engine ("trend persistence").
 *
 * Signal logic (LONG-ONLY, like Fintual):
 *   buy  — trailing return (last bar vs bar `lookback` ago) exceeds buyThreshold
 *           AND price is near its recent high (within nearHighFraction).
 *   sell — trailing return falls at or below sellThreshold (exit).
 *   hold — everything else, or insufficient data.
 *
 * No lookahead: only the `bars` array supplied to `evaluate` is used.
 * Never throws: insufficient data returns a low-confidence hold.
 */
export class MomentumEngine implements SignalEngine {
  private readonly lookback: number;
  private readonly longLookback: number;
  private readonly buyThreshold: number;
  private readonly sellThreshold: number;
  private readonly returnCap: number;
  private readonly nearHighFraction: number;

  constructor(options: MomentumEngineOptions = {}) {
    this.lookback = options.lookback ?? 126;
    this.longLookback = options.longLookback ?? 252;
    this.buyThreshold = options.buyThreshold ?? 0.05;
    this.sellThreshold = options.sellThreshold ?? 0.0;
    this.returnCap = options.returnCap ?? 0.50;
    this.nearHighFraction = options.nearHighFraction ?? 0.95;
  }

  async evaluate(ticker: string, bars: PriceBar[]): Promise<Signal> {
    // ── Insufficient data guard ────────────────────────────────────────────────
    if (bars.length < 2) {
      return insufficientHold(ticker, 'fewer than 2 bars');
    }

    const closes = bars.map((b) => b.close);
    const currentClose = closes[closes.length - 1]!;

    // Need at least `lookback + 1` bars to compute the primary return.
    // If we have fewer, we still try with whatever history is available but
    // heavily penalise confidence via the data penalty factor.
    const effectiveLookback = Math.min(this.lookback, closes.length - 1);
    const effectiveLongLookback =
      this.longLookback > 0 ? Math.min(this.longLookback, closes.length - 1) : 0;

    // ── Primary trailing return ────────────────────────────────────────────────
    const pastClose = closes[closes.length - 1 - effectiveLookback]!;
    if (pastClose <= 0) {
      return insufficientHold(ticker, 'zero or negative past close price');
    }
    const primaryReturn = (currentClose - pastClose) / pastClose;

    // ── Optional secondary (long) trailing return ──────────────────────────────
    let longReturn: number | null = null;
    if (effectiveLongLookback > 0 && effectiveLongLookback !== effectiveLookback) {
      const longPastClose = closes[closes.length - 1 - effectiveLongLookback]!;
      if (longPastClose > 0) {
        longReturn = (currentClose - longPastClose) / longPastClose;
      }
    }

    // ── Recent-high filter (for buy confirmation) ──────────────────────────────
    const windowCloses = closes.slice(Math.max(0, closes.length - 1 - effectiveLookback));
    const recentHigh = Math.max(...windowCloses);
    const nearHigh = recentHigh > 0 && currentClose >= recentHigh * this.nearHighFraction;

    // ── Data availability penalty ──────────────────────────────────────────────
    const dataFactor = computeDataFactor(bars.length, this.lookback);

    // ── Decision logic ─────────────────────────────────────────────────────────
    const reasons: string[] = [];

    const shortLabel = `${effectiveLookback}B`;
    reasons.push(`${shortLabel} return ${formatPct(primaryReturn)}`);

    if (longReturn !== null) {
      reasons.push(`${effectiveLongLookback}B return ${formatPct(longReturn)}`);
    }

    if (primaryReturn > this.sellThreshold && !nearHigh) {
      reasons.push(`price ${formatPct((currentClose / recentHigh) - 1)} below recent high`);
    }

    // ── BUY condition ──────────────────────────────────────────────────────────
    if (primaryReturn > this.buyThreshold && nearHigh) {
      // Additional confirmation: if long return is available, require it to also be positive
      if (longReturn !== null && longReturn <= 0) {
        // Long-term trend is negative — downgrade to hold
        reasons.push('long-term trend negative, holding');
        return holdSignal(ticker, reasons, 0, computeConfidence(primaryReturn, this.returnCap, dataFactor));
      }

      const strength = computeStrength(primaryReturn, this.returnCap);
      const confidence = computeConfidence(primaryReturn, this.returnCap, dataFactor);

      return {
        ticker,
        action: 'buy',
        strength: round(strength),
        confidence: round(confidence),
        reasons,
        timestamp: new Date(),
      };
    }

    // ── SELL condition ─────────────────────────────────────────────────────────
    if (primaryReturn <= this.sellThreshold) {
      // Magnitude of negative return drives strength/confidence
      const absMomentum = Math.abs(primaryReturn);
      const strength = computeStrength(absMomentum, this.returnCap);
      const confidence = computeConfidence(absMomentum, this.returnCap, dataFactor);

      return {
        ticker,
        action: 'sell',
        strength: round(strength),
        confidence: round(confidence),
        reasons,
        timestamp: new Date(),
      };
    }

    // ── HOLD (positive but below buy threshold, or not near high) ─────────────
    const confidence = computeConfidence(Math.abs(primaryReturn), this.returnCap, dataFactor);
    return holdSignal(ticker, reasons, 0, round(confidence));
  }
}

// ─── Pure helpers (no side-effects, easily unit-testable) ─────────────────────

/**
 * Returns a 0–1 strength scaled by the magnitude of `ret` capped at `cap`.
 * Uses a square-root curve so moderate returns already score reasonably.
 */
function computeStrength(ret: number, cap: number): number {
  if (cap <= 0) return 0;
  const raw = Math.min(Math.abs(ret) / cap, 1);
  return Math.sqrt(raw); // sqrt gives faster initial ramp-up
}

/**
 * Confidence = strength × data penalty factor.
 */
function computeConfidence(ret: number, cap: number, dataFactor: number): number {
  return computeStrength(ret, cap) * dataFactor;
}

/**
 * Linear interpolation: full weight once we have `lookback + 1` bars.
 * Scales from 0.25 at 2 bars up to 1.0 at `lookback + 1` bars.
 */
function computeDataFactor(barCount: number, lookback: number): number {
  const minBars = 2;
  const fullBars = lookback + 1;
  if (barCount >= fullBars) return 1.0;
  const ratio = (barCount - minBars) / Math.max(1, fullBars - minBars);
  return 0.25 + 0.75 * Math.max(0, Math.min(1, ratio));
}

function holdSignal(ticker: string, reasons: string[], strength: number, confidence: number): Signal {
  return { ticker, action: 'hold', strength, confidence, reasons, timestamp: new Date() };
}

function insufficientHold(ticker: string, detail: string): Signal {
  return {
    ticker,
    action: 'hold',
    strength: 0,
    confidence: 0,
    reasons: [`insufficient data: ${detail}`],
    timestamp: new Date(),
  };
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
