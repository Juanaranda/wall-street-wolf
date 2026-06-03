/**
 * Out-of-sample (OOS) validation.
 *
 * The danger with the comparison results is overfitting / regime luck: a strategy
 * can look great on the exact period we eyeballed. This splits the timeline by a
 * fixed date and reports each strategy's metrics SEPARATELY for the in-sample
 * (train) period and the out-of-sample (test) period.
 *
 * Honest reading: if a strategy's edge (win% / expectancy / PF) HOLDS in the test
 * period it never "saw", it's more likely real. If it collapses, it was luck.
 *
 * Method: the engine always sees full prior history at each step (no warmup
 * discontinuity); trades are bucketed into train/test by their ENTRY date.
 *
 * Usage:
 *   npm run validate                         # whole universe
 *   npm run validate -- SQM AAPL SPY
 *   TRAIN_END=2023-01-01 BACKTEST_BARS=2000 npm run validate
 */
import 'dotenv/config';
import { StaticUniverse } from '../src/universe';
import { createDataProvider } from '../src/data';
import { PriceBar } from '../src/shared/types';
import { SignalEngine, TechnicalSignalEngine } from '../src/signals';
import { TrendFollowingEngine } from '../src/signals/strategies/trend-following';
import { MomentumEngine } from '../src/signals/strategies/momentum';
import { MeanReversionEngine } from '../src/signals/strategies/mean-reversion';
import {
  Backtester,
  computeBacktestMetrics,
  BacktestResult,
  BacktestTrade,
} from '../src/backtest';

const TIMEFRAME = '1Day';
const LOOKBACK_BARS = parseInt(process.env['BACKTEST_BARS'] ?? '2000', 10); // ~8yr
const TRAIN_END = new Date(process.env['TRAIN_END'] ?? '2023-01-01');
const BACKTEST_CFG = { warmupBars: 200, maxHoldBars: 0, minConfidence: 0.5, feePct: 0.001 };

const STRATEGIES: Array<{ name: string; engine: SignalEngine }> = [
  { name: 'Baseline', engine: new TechnicalSignalEngine() },
  { name: 'Trend-following', engine: new TrendFollowingEngine() },
  { name: 'Momentum', engine: new MomentumEngine() },
  { name: 'Mean-reversion', engine: new MeanReversionEngine() },
];

function metricsFor(trades: BacktestTrade[]) {
  const wrapped: BacktestResult[] = [{ ticker: 'ALL', trades, barsEvaluated: 0 }];
  return computeBacktestMetrics(wrapped);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).map((t) => t.toUpperCase());
  const universe = await new StaticUniverse().list();
  const tickers = argv.length > 0 ? argv : universe.map((i) => i.ticker);

  const data = createDataProvider();

  console.log(`Fetching ${tickers.length} ticker(s) (~${LOOKBACK_BARS} bars)...`);
  const datasets: Array<{ ticker: string; bars: PriceBar[] }> = [];
  for (const ticker of tickers) {
    const bars = await data.getBars(ticker, TIMEFRAME, LOOKBACK_BARS);
    if (bars.length > 0) datasets.push({ ticker, bars });
  }
  const span = datasets[0]?.bars;
  console.log(
    `Got ${datasets.length} ticker(s). Split at ${TRAIN_END.toISOString().slice(0, 10)} ` +
      `(data ${span?.[0]?.timestamp.toISOString().slice(0, 10)} → ${span?.[span.length - 1]?.timestamp.toISOString().slice(0, 10)}).\n`
  );

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const pad = (s: string, n: number) => s.padEnd(n);
  const pf = (n: number) => (n === Infinity ? '∞' : n.toFixed(2));

  console.log(
    pad('Strategy', 16) +
      pad('| IN-SAMPLE (train)', 34) +
      '| OUT-OF-SAMPLE (test)'
  );
  console.log(
    pad('', 16) +
      pad('| n     win%    avg     PF', 34) +
      '| n     win%    avg     PF'
  );
  console.log('─'.repeat(88));

  for (const { name, engine } of STRATEGIES) {
    const backtester = new Backtester(engine, BACKTEST_CFG);
    const all: BacktestTrade[] = [];
    for (const ds of datasets) all.push(...(await backtester.run(ds.ticker, ds.bars)).trades);

    const train = all.filter((t) => t.entryTime < TRAIN_END);
    const test = all.filter((t) => t.entryTime >= TRAIN_END);
    const mTr = metricsFor(train);
    const mTe = metricsFor(test);

    const cell = (m: ReturnType<typeof metricsFor>) =>
      pad(String(m.totalTrades), 6) + pad(pct(m.winRate), 8) + pad(pct(m.avgReturnPct), 8) + pf(m.profitFactor);

    console.log(pad(name, 16) + '| ' + pad(cell(mTr), 32) + '| ' + cell(mTe));
  }

  console.log(
    '\nRobust = edge (win%/avg/PF) survives in OUT-OF-SAMPLE. Collapse there = luck/overfit.'
  );
}

main().catch((err) => {
  console.error('OOS validation failed:', err);
  process.exit(1);
});
