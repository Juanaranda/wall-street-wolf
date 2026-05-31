/**
 * src/signals/strategies/trend-following.ts
 *
 * Trend-following SignalEngine based on SMA50 / SMA200 regime detection.
 *
 * Rules (long-only, low-frequency):
 *   BUY  — confirmed uptrend: price > SMA50, SMA50 > SMA200 by >= MIN_SPREAD_PCT
 *   SELL — trend breakdown: price < SMA50 OR SMA50 < SMA200 by >= MIN_SPREAD_PCT
 *   HOLD — neither condition met (neutral deadband or ambiguous regime)
 *
 * A neutral deadband (MIN_SPREAD_PCT) prevents choppy / flat markets from
 * generating spurious buy or sell signals when the two MAs are nearly equal.
 *
 * strength / confidence are derived from the relative spread between the two
 * moving averages and the price's distance above SMA200, both normalised to [0, 1].
 *
 * NO lookahead: the function only reads `bars` as supplied (data up to "now").
 * NEVER throws: insufficient data is returned as a low-confidence hold.
 */

import { SignalEngine } from '../index';
import { PriceBar, Signal } from '../../shared/types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Longest MA window; we need at least this many bars before producing any signal. */
const SMA200_PERIOD = 200;
/** Short MA window used for the golden-cross check and the exit rule. */
const SMA50_PERIOD = 50;

/**
 * Minimum SMA50/SMA200 spread (as a fraction of SMA200) required to classify
 * a regime as uptrend or downtrend.  When |(SMA50 - SMA200)| / SMA200 is below
 * this value the engine returns hold (neutral deadband).
 *
 * 0.5 % is intentionally tight so only genuine chop / flat markets are filtered;
 * real golden/death crosses of meaningful magnitude still fire normally.
 */
const MIN_SPREAD_PCT = 0.005;

/**
 * Maximum normalised spread used to clamp the strength to 1.
 * A spread of 10 % of SMA200 maps to strength = 1.
 */
const MAX_SPREAD_RATIO = 0.10;

/**
 * Maximum price-above-SMA200 ratio used to clamp confidence to 1.
 * Price 5 % above SMA200 maps to confidence = 1.
 */
const MAX_PRICE_ABOVE_RATIO = 0.05;

// ─── Helper: simple moving average ───────────────────────────────────────────

/**
 * Returns the simple moving average of the last `period` values of `arr`,
 * or `null` when there are not enough values.
 */
function sma(arr: readonly number[], period: number): number | null {
  if (arr.length < period) return null;
  const slice = arr.slice(arr.length - period);
  return slice.reduce((acc, v) => acc + v, 0) / period;
}

// ─── Helper: normalise a ratio to [0, 1] ─────────────────────────────────────

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ─── Sentinel responses ───────────────────────────────────────────────────────

function holdSignal(ticker: string, reasons: string[]): Signal {
  return {
    ticker,
    action: 'hold',
    strength: 0,
    confidence: 0,
    reasons,
    timestamp: new Date(),
  };
}

// ─── TrendFollowingEngine ─────────────────────────────────────────────────────

/**
 * Classic dual-SMA trend-following engine with a neutral deadband.
 *
 * Strategy in two lines:
 *   Enter (buy) when SMA50 > SMA200 by >= MIN_SPREAD_PCT and price > SMA50
 *   (confirmed golden-cross uptrend); exit (sell) when price < SMA50 or SMA50
 *   drops below SMA200 by >= MIN_SPREAD_PCT; hold in between (deadband).
 */
export class TrendFollowingEngine implements SignalEngine {
  async evaluate(ticker: string, bars: PriceBar[]): Promise<Signal> {
    const closes = bars.map((b) => b.close);

    // ── Guard: need at least SMA200_PERIOD bars ───────────────────────────────
    if (closes.length < SMA200_PERIOD) {
      return holdSignal(ticker, [
        `insufficient data: need ${SMA200_PERIOD} bars, have ${closes.length}`,
      ]);
    }

    const sma200 = sma(closes, SMA200_PERIOD)!; // non-null: length >= 200
    const sma50  = sma(closes, SMA50_PERIOD)!;  // non-null: length >= 200 >= 50
    const price  = closes[closes.length - 1]!;

    // Guard against degenerate data (NaN, zero SMA200)
    if (!Number.isFinite(sma200) || !Number.isFinite(sma50) || !Number.isFinite(price) || sma200 === 0) {
      return holdSignal(ticker, ['degenerate price data — cannot compute MAs']);
    }

    const sma200Str = sma200.toFixed(2);
    const sma50Str  = sma50.toFixed(2);
    const priceStr  = price.toFixed(2);

    // ── Compute regime spread (positive = SMA50 above SMA200) ────────────────
    const spreadRatio = (sma50 - sma200) / sma200; // signed

    // ── Deadband guard: if the cross hasn't materialised enough, hold ─────────
    //   When |spreadRatio| < MIN_SPREAD_PCT the two MAs are essentially equal
    //   and we have no clear trend signal.  Return hold immediately.
    if (Math.abs(spreadRatio) < MIN_SPREAD_PCT) {
      return holdSignal(ticker, [
        `price ${priceStr}, SMA50 ${sma50Str}, SMA200 ${sma200Str} — within neutral deadband`,
      ]);
    }

    // ── SELL: clear downtrend or price breakdown ──────────────────────────────
    //   Condition A: price has fallen below SMA50 (immediate exit signal)
    //   Condition B: SMA50 is below SMA200 by at least MIN_SPREAD_PCT (death cross confirmed)
    const deathCrossConfirmed = spreadRatio < -MIN_SPREAD_PCT;
    const priceBelow50 = price < sma50;

    if (priceBelow50 || deathCrossConfirmed) {
      const sellReasons: string[] = [];

      if (priceBelow50) {
        sellReasons.push(
          `price ${priceStr} < SMA50 ${sma50Str} — trend break exit`
        );
      }
      if (deathCrossConfirmed) {
        sellReasons.push(
          `SMA50 ${sma50Str} <= SMA200 ${sma200Str} — golden cross broken`
        );
      }

      // Sell strength is proportional to how far below SMA50 the price has dropped.
      const breakdownDepth = sma50 > 0
        ? clamp01((sma50 - price) / sma50 / MAX_SPREAD_RATIO)
        : 0.5;

      // When the cross itself has broken, bump strength to at least 0.5.
      const crossContribution = deathCrossConfirmed
        ? clamp01(Math.abs(spreadRatio) / MAX_SPREAD_RATIO)
        : 0;

      const strength   = round3(Math.max(breakdownDepth, crossContribution));
      const confidence = round3(clamp01(strength));

      return { ticker, action: 'sell', strength, confidence, reasons: sellReasons, timestamp: new Date() };
    }

    // ── BUY: confirmed uptrend (golden-cross regime) ──────────────────────────
    //   SMA50 > SMA200 by >= MIN_SPREAD_PCT  AND  price > SMA50
    const goldenCrossConfirmed = spreadRatio >= MIN_SPREAD_PCT;

    if (goldenCrossConfirmed && price > sma50) {
      const buyReasons: string[] = [
        `price ${priceStr} > SMA50 ${sma50Str} — riding confirmed uptrend`,
        `SMA50 ${sma50Str} > SMA200 ${sma200Str} — golden-cross regime active`,
      ];

      // strength = normalised SMA50/SMA200 spread (how established is the uptrend)
      const strength = round3(clamp01(spreadRatio / MAX_SPREAD_RATIO));

      // confidence = how far price is above SMA200 (momentum depth)
      const priceAboveRatio = (price - sma200) / sma200;
      const confidence      = round3(clamp01(priceAboveRatio / MAX_PRICE_ABOVE_RATIO));

      return { ticker, action: 'buy', strength, confidence, reasons: buyReasons, timestamp: new Date() };
    }

    // ── HOLD: golden cross confirmed but price hasn't crossed above SMA50 yet ──
    //   SMA50 > SMA200 by >= MIN_SPREAD_PCT yet price <= SMA50 — wait for entry.
    return holdSignal(ticker, [
      `price ${priceStr} <= SMA50 ${sma50Str} — awaiting price confirmation of golden-cross uptrend`,
    ]);
  }
}

export default TrendFollowingEngine;
