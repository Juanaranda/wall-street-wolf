import { PriceBar } from '../shared/types';
import { SignalEngine } from '../signals';
import {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  DEFAULT_BACKTEST_CONFIG,
} from './types';

/**
 * Walk-forward backtester.
 *
 * HONESTY GUARANTEE (no lookahead): at each step `i`, the signal is computed from
 * `bars.slice(0, i + 1)` — ONLY data available up to and including bar `i`. The
 * outcome is then measured against strictly-future bars (`i+1 … i+holding`). The
 * signal engine can never see a bar it would not have seen in live trading.
 *
 * Positions are non-overlapping (one at a time): after a trade exits at bar `e`,
 * evaluation resumes at `e + 1`.
 */
export class Backtester {
  private readonly config: BacktestConfig;

  constructor(
    private readonly engine: SignalEngine,
    config: Partial<BacktestConfig> = {}
  ) {
    this.config = { ...DEFAULT_BACKTEST_CONFIG, ...config };
  }

  async run(ticker: string, bars: PriceBar[]): Promise<BacktestResult> {
    const trades: BacktestTrade[] = [];
    const { warmupBars, holdingPeriodBars, minConfidence, feePct } = this.config;

    // Need at least one future bar to measure an outcome.
    let i = Math.max(warmupBars, 1);
    while (i < bars.length - 1) {
      // No lookahead: the engine only ever sees bars[0 … i].
      const window = bars.slice(0, i + 1);
      const signal = await this.engine.evaluate(ticker, window);

      if (signal.action === 'hold' || signal.confidence < minConfidence) {
        i += 1;
        continue;
      }
      const action: 'buy' | 'sell' = signal.action;

      const entryBar = bars[i]!;
      const exitIndex = Math.min(i + holdingPeriodBars, bars.length - 1);
      const exitBar = bars[exitIndex]!;

      const rawReturn =
        action === 'buy'
          ? (exitBar.close - entryBar.close) / entryBar.close
          : (entryBar.close - exitBar.close) / entryBar.close;
      const returnPct = rawReturn - feePct;

      trades.push({
        ticker,
        action,
        entryIndex: i,
        entryTime: entryBar.timestamp,
        entryPrice: entryBar.close,
        exitIndex,
        exitTime: exitBar.timestamp,
        exitPrice: exitBar.close,
        confidence: signal.confidence,
        returnPct,
        win: returnPct > 0,
        reasons: signal.reasons,
      });

      // Non-overlapping: resume after the exit.
      i = exitIndex + 1;
    }

    return { ticker, trades, barsEvaluated: Math.max(0, bars.length - warmupBars) };
  }

  /** Backtest several instruments and flatten the results. */
  async runMany(series: Array<{ ticker: string; bars: PriceBar[] }>): Promise<BacktestResult[]> {
    const results: BacktestResult[] = [];
    for (const { ticker, bars } of series) {
      results.push(await this.run(ticker, bars));
    }
    return results;
  }
}

export * from './types';
export * from './metrics';
