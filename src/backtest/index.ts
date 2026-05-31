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
    const { warmupBars, maxHoldBars, minConfidence, feePct } = this.config;

    interface OpenPos {
      entryIndex: number;
      entryPrice: number;
      confidence: number;
      reasons: string[];
    }
    let pos: OpenPos | null = null;

    const closeAt = (
      p: OpenPos,
      exitIndex: number,
      exitReason: BacktestTrade['exitReason']
    ): void => {
      const exitBar = bars[exitIndex]!;
      const returnPct = (exitBar.close - p.entryPrice) / p.entryPrice - feePct;
      trades.push({
        ticker,
        action: 'buy',
        entryIndex: p.entryIndex,
        entryTime: bars[p.entryIndex]!.timestamp,
        entryPrice: p.entryPrice,
        exitIndex,
        exitTime: exitBar.timestamp,
        exitPrice: exitBar.close,
        confidence: p.confidence,
        returnPct,
        win: returnPct > 0,
        reasons: p.reasons,
        exitReason,
      });
    };

    for (let i = Math.max(warmupBars, 1); i < bars.length; i++) {
      // No lookahead: the engine only ever sees bars[0 … i].
      const window = bars.slice(0, i + 1);
      const signal = await this.engine.evaluate(ticker, window);
      const price = bars[i]!.close;

      if (pos === null) {
        // Enter long on a confident buy — but not on the very last bar (no exit room).
        if (signal.action === 'buy' && signal.confidence >= minConfidence && i < bars.length - 1) {
          pos = { entryIndex: i, entryPrice: price, confidence: signal.confidence, reasons: signal.reasons };
        }
      } else {
        const heldBars = i - pos.entryIndex;
        const timedOut = maxHoldBars > 0 && heldBars >= maxHoldBars;
        if (signal.action === 'sell') {
          closeAt(pos, i, 'sell-signal');
          pos = null;
        } else if (timedOut) {
          closeAt(pos, i, 'timeout');
          pos = null;
        }
      }
    }

    // Force-close any position still open at the end of the data.
    if (pos !== null) closeAt(pos, bars.length - 1, 'end-of-data');

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
