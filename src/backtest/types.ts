/**
 * Configuration for a walk-forward backtest run.
 *
 * LONG-ONLY model (matches Fintual reality): a 'buy' opens a long position when
 * flat; a 'sell' exits an open long; 'hold' does nothing. The bot never shorts.
 */
export interface BacktestConfig {
  /** Minimum bars required before the first signal is evaluated (indicator warmup). */
  warmupBars: number;
  /** Max bars to hold before a forced exit. 0 = hold until a 'sell' signal. */
  maxHoldBars: number;
  /** Only ENTER on 'buy' signals whose confidence is ≥ this threshold. */
  minConfidence: number;
  /** Round-trip cost as a fraction (e.g. 0.001 = 0.1%, Fintual beyond 10 free orders/mo). */
  feePct: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  warmupBars: 60,
  maxHoldBars: 0,
  minConfidence: 0.6,
  feePct: 0,
};

/** A single simulated LONG trade produced by the backtester. */
export interface BacktestTrade {
  ticker: string;
  /** Always 'buy' — long-only model. Entry on a buy signal, exit on sell/timeout. */
  action: 'buy';
  entryIndex: number;
  entryTime: Date;
  entryPrice: number;
  exitIndex: number;
  exitTime: Date;
  exitPrice: number;
  /** Confidence of the entry signal. */
  confidence: number;
  /** Net long return as a fraction: (exit − entry) / entry − fees. */
  returnPct: number;
  win: boolean;
  /** Reasons from the entry signal. */
  reasons: string[];
  /** How the position was closed. */
  exitReason: 'sell-signal' | 'timeout' | 'end-of-data';
}

/** Result of backtesting one instrument. */
export interface BacktestResult {
  ticker: string;
  trades: BacktestTrade[];
  /** Number of bars over which signals could have been generated. */
  barsEvaluated: number;
}

/** One confidence bucket of the calibration report. */
export interface CalibrationBucket {
  /** Inclusive lower bound of the confidence range (e.g. 0.6). */
  rangeStart: number;
  /** Exclusive upper bound (e.g. 0.7); the top bucket is inclusive of 1.0. */
  rangeEnd: number;
  trades: number;
  wins: number;
  /** Realized win rate in this bucket (wins / trades), or null if empty. */
  realizedWinRate: number | null;
}

/** Aggregate performance metrics computed from backtest trades. */
export interface BacktestMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Mean per-trade return (fraction). */
  avgReturnPct: number;
  /** Equity multiple from compounding sequential trade returns (1.0 = breakeven). */
  cumulativeReturn: number;
  /** sum(gains) / |sum(losses)|; Infinity if no losses, 0 if no gains. */
  profitFactor: number;
  /** Per-trade Sharpe (mean / stddev of trade returns); NOT annualized. */
  sharpe: number;
  /** Worst peak-to-trough drawdown on the sequential equity curve (fraction, ≥ 0). */
  maxDrawdown: number;
  /** Win rate bucketed by signal confidence — does higher confidence mean more wins? */
  calibration: CalibrationBucket[];
}
