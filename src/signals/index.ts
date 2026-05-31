import { PriceBar, Signal } from '../shared/types';
import { calculateIndicators } from '../indicators';

// ─── Public interface ────────────────────────────────────────────────────────

export interface SignalEngine {
  evaluate(ticker: string, bars: PriceBar[]): Promise<Signal>;
}

// ─── Minimum data thresholds ─────────────────────────────────────────────────

/** Fewer bars than this triggers a data-penalty on confidence. */
const MIN_BARS_FULL_CONFIDENCE = 60;
/** Below this the engine returns an immediate low-confidence hold. */
const MIN_BARS_REQUIRED = 2;

// ─── TechnicalSignalEngine ───────────────────────────────────────────────────

/**
 * Cost-$0 technical signal engine.
 *
 * Improvement surface vs. the baseline:
 * 1. Reasons array is populated with every indicator that fired and its value.
 * 2. Confidence is a composite of indicator agreement + EMA trend + data-volume
 *    penalty (penalises fewer than MIN_BARS_FULL_CONFIDENCE bars).
 * 3. EMA20 vs EMA50 momentum check is added as an explicit agreement factor.
 * 4. The action threshold is tighter: strength must exceed 0.35 (vs implicit 0
 *    in the old baseline) to avoid noise on weak consensus.
 */
export class TechnicalSignalEngine implements SignalEngine {
  async evaluate(ticker: string, bars: PriceBar[]): Promise<Signal> {
    const closes = bars.map((b) => b.close);

    if (closes.length < MIN_BARS_REQUIRED) {
      return insufficientDataSignal(ticker, 'less than 2 bars');
    }

    const ind = calculateIndicators(closes);
    const currentPrice = closes[closes.length - 1]!;

    // ── 1. Collect individual indicator votes ────────────────────────────────

    const buyVotes: string[] = [];
    const sellVotes: string[] = [];

    // RSI
    if (ind.rsi !== null) {
      if (ind.rsi < 35) {
        buyVotes.push(`RSI=${ind.rsi.toFixed(1)} (oversold)`);
      } else if (ind.rsi > 65) {
        sellVotes.push(`RSI=${ind.rsi.toFixed(1)} (overbought)`);
      }
    }

    // MACD histogram
    if (ind.macd !== null) {
      const prevHistogram = (ind.macd as any)._prevHistogram as number | undefined;
      const crossedBullish = prevHistogram !== undefined && prevHistogram < 0 && ind.macd.histogram > 0;
      const crossedBearish = prevHistogram !== undefined && prevHistogram > 0 && ind.macd.histogram < 0;

      if (crossedBullish) {
        buyVotes.push(`MACD bullish crossover (hist=${ind.macd.histogram.toFixed(3)})`);
      } else if (ind.macd.histogram > 0) {
        buyVotes.push(`MACD hist=${ind.macd.histogram.toFixed(3)} (positive)`);
      } else if (crossedBearish) {
        sellVotes.push(`MACD bearish crossover (hist=${ind.macd.histogram.toFixed(3)})`);
      } else if (ind.macd.histogram < 0) {
        sellVotes.push(`MACD hist=${ind.macd.histogram.toFixed(3)} (negative)`);
      }
    }

    // Bollinger Bands
    if (ind.bb !== null) {
      const bbRange = ind.bb.upper - ind.bb.lower;
      if (bbRange > 0) {
        const pctB = (currentPrice - ind.bb.lower) / bbRange;
        if (pctB < 0.2) {
          buyVotes.push(`BB pctB=${pctB.toFixed(2)} (near lower band)`);
        } else if (pctB > 0.8) {
          sellVotes.push(`BB pctB=${pctB.toFixed(2)} (near upper band)`);
        }
      }
    }

    // EMA20 vs EMA50 momentum/trend
    const emaTrend = deriveEmaTrend(ind.ema20, ind.ema50, currentPrice);
    if (emaTrend === 'bullish') {
      buyVotes.push(
        `EMA trend bullish (EMA20=${ind.ema20!.toFixed(2)} > EMA50=${ind.ema50!.toFixed(2)})`
      );
    } else if (emaTrend === 'bearish') {
      sellVotes.push(
        `EMA trend bearish (EMA20=${ind.ema20!.toFixed(2)} < EMA50=${ind.ema50!.toFixed(2)})`
      );
    }

    // ── 2. Determine action from vote counts ─────────────────────────────────

    const totalFactors = buyVotes.length + sellVotes.length;

    // If no indicators fired at all, stay flat
    if (totalFactors === 0) {
      return holdSignal(ticker, ['no indicator signals fired']);
    }

    const buyWeight = buyVotes.length / totalFactors;
    const sellWeight = sellVotes.length / totalFactors;

    let action: Signal['action'];
    let strength: number;
    let reasons: string[];

    if (buyVotes.length > sellVotes.length && buyWeight >= 0.6) {
      action = 'buy';
      strength = buyWeight;
      reasons = buyVotes;
    } else if (sellVotes.length > buyVotes.length && sellWeight >= 0.6) {
      action = 'sell';
      strength = sellWeight;
      reasons = sellVotes;
    } else {
      // Mixed signals → hold, list everything
      action = 'hold';
      strength = 0;
      reasons = [...buyVotes, ...sellVotes];
      if (reasons.length === 0) reasons = ['mixed signals, no clear direction'];
    }

    // Enforce minimum strength threshold to suppress noise
    if (action !== 'hold' && strength < 0.35) {
      return holdSignal(ticker, [`strength ${strength.toFixed(2)} below threshold`, ...reasons]);
    }

    // ── 3. Confidence = strength × indicator agreement × data-volume factor ──

    const agreementRatio = action === 'hold' ? 0 : Math.max(buyWeight, sellWeight);
    const dataFactor = dataPenaltyFactor(closes.length);
    const confidence = round(agreementRatio * dataFactor);

    return {
      ticker,
      action,
      strength: round(strength),
      confidence,
      reasons,
      timestamp: new Date(),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveEmaTrend(
  ema20: number | null,
  ema50: number | null,
  currentPrice: number
): 'bullish' | 'bearish' | 'neutral' {
  if (ema20 === null || ema50 === null) return 'neutral';
  // Price above both EMAs and short MA above long MA = bullish trend
  if (ema20 > ema50 && currentPrice > ema20) return 'bullish';
  // Price below both EMAs and short MA below long MA = bearish trend
  if (ema20 < ema50 && currentPrice < ema20) return 'bearish';
  return 'neutral';
}

/**
 * Returns a multiplier in (0, 1] that penalises short bar series.
 * Full weight at MIN_BARS_FULL_CONFIDENCE; scales linearly down to 0.4
 * for very short series.
 */
function dataPenaltyFactor(barCount: number): number {
  if (barCount >= MIN_BARS_FULL_CONFIDENCE) return 1.0;
  // Linear interpolation: 2 bars → 0.4, MIN_BARS_FULL_CONFIDENCE → 1.0
  const ratio = (barCount - MIN_BARS_REQUIRED) / (MIN_BARS_FULL_CONFIDENCE - MIN_BARS_REQUIRED);
  return 0.4 + 0.6 * Math.max(0, Math.min(1, ratio));
}

function holdSignal(ticker: string, reasons: string[]): Signal {
  return { ticker, action: 'hold', strength: 0, confidence: 0, reasons, timestamp: new Date() };
}

function insufficientDataSignal(ticker: string, detail: string): Signal {
  return {
    ticker,
    action: 'hold',
    strength: 0,
    confidence: 0,
    reasons: [`insufficient data: ${detail}`],
    timestamp: new Date(),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ─── LlmGatedSignalEngine ─────────────────────────────────────────────────────

/**
 * Optional wrapper that passes the output of an inner SignalEngine through an
 * LLM gate for high-strength candidates.
 *
 * Design principles:
 * - Disabled by default: `enabled` flag must be explicitly set to `true`.
 * - Only calls the LLM when `signal.strength >= strengthThreshold`.
 * - Respects a daily cost cap (`maxDailyCostUsd`); once exceeded the LLM call
 *   is skipped and the inner signal is returned unchanged.
 * - The `LlmCaller` interface is intentionally minimal so tests can inject a
 *   no-op stub without any network interaction.
 * - Makes NO network calls when `enabled` is false (the default).
 */
export interface LlmCaller {
  /**
   * Ask the LLM whether the signal looks valid given recent context.
   * Returns a confidence adjustment in [-0.3, +0.3] and optional extra reasons.
   * Must throw if cost cap would be exceeded.
   */
  gate(
    ticker: string,
    signal: Signal
  ): Promise<{ confidenceDelta: number; additionalReasons: string[]; estimatedCostUsd: number }>;
}

export interface LlmGateOptions {
  /** If false (default) the LLM gate is completely bypassed. */
  enabled?: boolean;
  /** Minimum signal strength required before calling the LLM. Default: 0.7 */
  strengthThreshold?: number;
  /** Max USD spent on LLM calls per calendar day. Default: 0.10 */
  maxDailyCostUsd?: number;
}

export class LlmGatedSignalEngine implements SignalEngine {
  private readonly inner: SignalEngine;
  private readonly llm: LlmCaller;
  private readonly enabled: boolean;
  private readonly strengthThreshold: number;
  private readonly maxDailyCostUsd: number;

  /** Accumulated cost reset each calendar day. */
  private dailyCostUsd = 0;
  private costDay = todayKey();

  constructor(inner: SignalEngine, llm: LlmCaller, options: LlmGateOptions = {}) {
    this.inner = inner;
    this.llm = llm;
    this.enabled = options.enabled ?? false;
    this.strengthThreshold = options.strengthThreshold ?? 0.7;
    this.maxDailyCostUsd = options.maxDailyCostUsd ?? 0.10;
  }

  async evaluate(ticker: string, bars: PriceBar[]): Promise<Signal> {
    const signal = await this.inner.evaluate(ticker, bars);

    if (!this.enabled) return signal;
    if (signal.action === 'hold') return signal;
    if (signal.strength < this.strengthThreshold) return signal;

    this.resetDailyCostIfNewDay();

    if (this.dailyCostUsd >= this.maxDailyCostUsd) {
      return {
        ...signal,
        reasons: [...signal.reasons, 'LLM gate skipped: daily cost cap reached'],
      };
    }

    try {
      const result = await this.llm.gate(ticker, signal);
      this.dailyCostUsd += result.estimatedCostUsd;

      const newConfidence = Math.max(0, Math.min(1, signal.confidence + result.confidenceDelta));
      return {
        ...signal,
        confidence: round(newConfidence),
        reasons: [...signal.reasons, ...result.additionalReasons],
      };
    } catch {
      // LLM unavailable / cap exceeded inside caller — degrade gracefully
      return {
        ...signal,
        reasons: [...signal.reasons, 'LLM gate unavailable, technical signal used'],
      };
    }
  }

  /** Expose accumulated daily cost (primarily for tests/monitoring). */
  getDailyCostUsd(): number {
    return this.dailyCostUsd;
  }

  private resetDailyCostIfNewDay(): void {
    const today = todayKey();
    if (today !== this.costDay) {
      this.dailyCostUsd = 0;
      this.costDay = today;
    }
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Default export (keeps orchestrator.ts working) ──────────────────────────

export default TechnicalSignalEngine;
