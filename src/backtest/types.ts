/** Configuration for a walk-forward backtest run. */
export interface BacktestConfig {
  /** Minimum bars required before the first signal is evaluated (indicator warmup). */
  warmupBars: number;
  /** Number of bars to hold a position after entry before exiting. */
  holdingPeriodBars: number;
  /** Only act on signals whose confidence is ≥ this threshold. */
  minConfidence: number;
  /** Round-trip cost as a fraction (e.g. 0.001 = 0.1%, Fintual beyond 10 free orders/mo). */
  feePct: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  warmupBars: 60,
  holdingPeriodBars: 5,
  minConfidence: 0.6,
  feePct: 0,
};

/** A single simulated trade produced by the backtester. */
export interface BacktestTrade {
  ticker: string;
  action: 'buy' | 'sell';
  entryIndex: number;
  entryTime: Date;
  entryPrice: number;
  exitIndex: number;
  exitTime: Date;
  exitPrice: number;
  confidence: number;
  /**
   * Net return as a fraction, sign-adjusted for the signal direction:
   * a 'buy' profits when price rises, a 'sell' profits when price falls.
   * This measures the *predictive quality* of the signal. (Fintual is long-only;
   * a 'sell' in practice means exit/avoid — see report for the long-only view.)
   */
  returnPct: number;
  win: boolean;
  reasons: string[];
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
