import { computeBacktestMetrics, formatBacktestReport } from '../src/backtest/metrics';
import { BacktestResult, BacktestTrade } from '../src/backtest/types';

function trade(returnPct: number, confidence: number): BacktestTrade {
  return {
    ticker: 'AAA',
    action: 'buy',
    entryIndex: 0,
    entryTime: new Date(),
    entryPrice: 100,
    exitIndex: 1,
    exitTime: new Date(),
    exitPrice: 100 * (1 + returnPct),
    confidence,
    returnPct,
    win: returnPct > 0,
    reasons: [],
  };
}

function result(trades: BacktestTrade[]): BacktestResult {
  return { ticker: 'AAA', trades, barsEvaluated: 100 };
}

describe('computeBacktestMetrics', () => {
  it('handles the empty case', () => {
    const m = computeBacktestMetrics([]);
    expect(m.totalTrades).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.cumulativeReturn).toBe(1);
    expect(m.profitFactor).toBe(0);
  });

  it('computes win rate, averages and profit factor', () => {
    const m = computeBacktestMetrics([
      result([trade(0.1, 0.9), trade(-0.05, 0.7), trade(0.2, 0.8), trade(-0.05, 0.6)]),
    ]);
    expect(m.totalTrades).toBe(4);
    expect(m.wins).toBe(2);
    expect(m.losses).toBe(2);
    expect(m.winRate).toBe(0.5);
    expect(m.avgReturnPct).toBeCloseTo((0.1 - 0.05 + 0.2 - 0.05) / 4, 6);
    // gains=0.3, losses=0.1 → PF=3
    expect(m.profitFactor).toBeCloseTo(3, 6);
  });

  it('compounds the equity curve and measures drawdown', () => {
    // +10% then -10% → 1.1 * 0.9 = 0.99; peak 1.1 → dd = (1.1-0.99)/1.1 = 0.1
    const m = computeBacktestMetrics([result([trade(0.1, 0.8), trade(-0.1, 0.8)])]);
    expect(m.cumulativeReturn).toBeCloseTo(0.99, 6);
    expect(m.maxDrawdown).toBeCloseTo(0.1, 6);
  });

  it('reports Infinity profit factor when there are no losses', () => {
    const m = computeBacktestMetrics([result([trade(0.1, 0.9), trade(0.05, 0.9)])]);
    expect(m.profitFactor).toBe(Infinity);
  });

  it('buckets calibration by confidence', () => {
    const m = computeBacktestMetrics([
      result([
        trade(0.1, 0.65), // [0.6,0.7) win
        trade(-0.1, 0.62), // [0.6,0.7) loss
        trade(0.2, 0.95), // [0.9,1.0] win
      ]),
    ]);
    const b67 = m.calibration.find((b) => b.rangeStart === 0.6)!;
    expect(b67.trades).toBe(2);
    expect(b67.wins).toBe(1);
    expect(b67.realizedWinRate).toBeCloseTo(0.5, 6);

    const bTop = m.calibration.find((b) => b.rangeStart === 0.9)!;
    expect(bTop.trades).toBe(1);
    expect(bTop.realizedWinRate).toBe(1);

    const empty = m.calibration.find((b) => b.rangeStart === 0.5)!;
    expect(empty.realizedWinRate).toBeNull();
  });

  it('formats a readable report', () => {
    const m = computeBacktestMetrics([result([trade(0.1, 0.9), trade(-0.05, 0.7)])]);
    const report = formatBacktestReport(m);
    expect(report).toContain('Backtest Report');
    expect(report).toContain('Win rate');
    expect(report).toContain('Calibration');
  });
});
