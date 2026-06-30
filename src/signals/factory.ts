import { SignalEngine, LlmGatedSignalEngine } from './index';
import { MomentumEngine } from './strategies/momentum';
import { MeanReversionEngine } from './strategies/mean-reversion';
import { TrendFollowingEngine } from './strategies/trend-following';
import { SentimentLlmCaller } from './sentiment-gate';

/**
 * Build the live signal engine: momentum, optionally wrapped in the news-sentiment
 * LLM gate. The gate is ON only when OPENROUTER_API_KEY is set (and not explicitly
 * disabled), so the system runs as pure technical momentum by default — no key,
 * no cost, no behaviour change.
 *
 * Env knobs:
 *   OPENROUTER_API_KEY     enable the gate (also needs FINNHUB_API_KEY for news)
 *   SENTIMENT_GATE=false   force-disable even if a key is present
 *   SENTIMENT_MIN_STRENGTH minimum signal strength to spend an LLM call (default 0.5)
 *   LLM_DAILY_CAP_USD      max LLM spend per day (default 0.10)
 */
export function createSignalEngine(): SignalEngine {
  const base = new MomentumEngine();
  const enabled = !!process.env['OPENROUTER_API_KEY'] && process.env['SENTIMENT_GATE'] !== 'false';
  if (!enabled) return base;

  return new LlmGatedSignalEngine(base, new SentimentLlmCaller(), {
    enabled: true,
    strengthThreshold: parseFloat(process.env['SENTIMENT_MIN_STRENGTH'] ?? '0.5'),
    maxDailyCostUsd: parseFloat(process.env['LLM_DAILY_CAP_USD'] ?? '0.10'),
  });
}

/** A named strategy engine with its investment horizon (for multi-strategy signals). */
export interface StrategyEngine {
  name: string;
  horizon: string;
  engine: SignalEngine;
  /** Only the exit-authority strategy may trigger SELLs on held positions. */
  exitAuthority?: boolean;
}

/**
 * The full set of strategies run each cycle. Each emits its own signals over one
 * shared cash pool; recommendations are tagged with the strategy + horizon.
 *   - Momentum (medium): trend persistence — the robust core (optionally LLM-gated).
 *   - Mean-reversion (short): buy deep dips, exit on the bounce — more frequent.
 *   - Trend-following (long): SMA50/200 regime — slow, low turnover.
 */
export function createSignalEngines(): StrategyEngine[] {
  return [
    { name: 'Momentum', horizon: 'mediano plazo', engine: createSignalEngine(), exitAuthority: true },
    { name: 'Mean-reversion', horizon: 'corto plazo', engine: new MeanReversionEngine() },
    { name: 'Trend-following', horizon: 'largo plazo', engine: new TrendFollowingEngine() },
  ];
}
