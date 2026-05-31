import { BacktestResult, BacktestTrade, BacktestMetrics, CalibrationBucket } from './types';

/** Flatten per-instrument results into a single trade list. */
export function allTrades(results: BacktestResult[]): BacktestTrade[] {
  return results.flatMap((r) => r.trades);
}

/** Default confidence buckets for calibration: [0.5,0.6),[0.6,0.7)…[0.9,1.0]. */
const DEFAULT_BUCKET_EDGES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

/**
 * Compute aggregate performance + calibration metrics from backtest results.
 * Returns is the per-trade fractional return (already net of fees).
 */
export function computeBacktestMetrics(
  results: BacktestResult[],
  bucketEdges: number[] = DEFAULT_BUCKET_EDGES
): BacktestMetrics {
  const trades = allTrades(results);
  const totalTrades = trades.length;

  if (totalTrades === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgReturnPct: 0,
      cumulativeReturn: 1,
      profitFactor: 0,
      sharpe: 0,
      maxDrawdown: 0,
      calibration: buildCalibration(trades, bucketEdges),
    };
  }

  const returns = trades.map((t) => t.returnPct);
  const wins = trades.filter((t) => t.win).length;
  const losses = totalTrades - wins;

  const sumReturn = returns.reduce((s, r) => s + r, 0);
  const avgReturnPct = sumReturn / totalTrades;

  const gains = returns.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const lossSum = returns.filter((r) => r < 0).reduce((s, r) => s + r, 0);
  const profitFactor = lossSum === 0 ? (gains > 0 ? Infinity : 0) : gains / Math.abs(lossSum);

  // Standard deviation (population) of trade returns → per-trade Sharpe.
  const variance = returns.reduce((s, r) => s + (r - avgReturnPct) ** 2, 0) / totalTrades;
  const stddev = Math.sqrt(variance);
  const sharpe = stddev === 0 ? 0 : avgReturnPct / stddev;

  // Equity curve by compounding sequential trade returns.
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    totalTrades,
    wins,
    losses,
    winRate: wins / totalTrades,
    avgReturnPct,
    cumulativeReturn: equity,
    profitFactor,
    sharpe,
    maxDrawdown,
    calibration: buildCalibration(trades, bucketEdges),
  };
}

function buildCalibration(trades: BacktestTrade[], edges: number[]): CalibrationBucket[] {
  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const rangeStart = edges[i]!;
    const rangeEnd = edges[i + 1]!;
    const isTop = i === edges.length - 2;
    const inBucket = trades.filter(
      (t) =>
        t.confidence >= rangeStart && (isTop ? t.confidence <= rangeEnd : t.confidence < rangeEnd)
    );
    const wins = inBucket.filter((t) => t.win).length;
    buckets.push({
      rangeStart,
      rangeEnd,
      trades: inBucket.length,
      wins,
      realizedWinRate: inBucket.length === 0 ? null : wins / inBucket.length,
    });
  }
  return buckets;
}

/** Human-readable backtest report. */
export function formatBacktestReport(metrics: BacktestMetrics): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [
    '═══ Backtest Report ═══',
    `Trades:           ${metrics.totalTrades} (${metrics.wins}W / ${metrics.losses}L)`,
    `Win rate:         ${pct(metrics.winRate)}`,
    `Avg return/trade: ${pct(metrics.avgReturnPct)}`,
    `Cumulative:       ${metrics.cumulativeReturn.toFixed(3)}x`,
    `Profit factor:    ${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}`,
    `Sharpe (/trade):  ${metrics.sharpe.toFixed(2)}`,
    `Max drawdown:     ${pct(metrics.maxDrawdown)}`,
    '',
    'Calibration (confidence → realized win rate):',
  ];
  for (const b of metrics.calibration) {
    const wr = b.realizedWinRate === null ? '—' : pct(b.realizedWinRate);
    lines.push(`  [${b.rangeStart.toFixed(1)}–${b.rangeEnd.toFixed(1)})  n=${b.trades}\twin=${wr}`);
  }
  return lines.join('\n');
}
