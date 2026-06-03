/**
 * Strategy comparison — backtests several signal strategies over the SAME real
 * data and prints a side-by-side table so we can see which (if any) has an edge.
 *
 * Usage:
 *   npm run compare                 # whole universe, 1Y daily
 *   npm run compare -- SQM AAPL SPY # specific tickers
 *
 * Requires ALPACA_API_KEY / ALPACA_API_SECRET in .env.
 */
import 'dotenv/config';
import { StaticUniverse } from '../src/universe';
import { createDataProvider } from '../src/data';
import { PriceBar } from '../src/shared/types';
import { SignalEngine, TechnicalSignalEngine } from '../src/signals';
import { TrendFollowingEngine } from '../src/signals/strategies/trend-following';
import { MomentumEngine } from '../src/signals/strategies/momentum';
import { MeanReversionEngine } from '../src/signals/strategies/mean-reversion';
import { Backtester, computeBacktestMetrics, BacktestResult } from '../src/backtest';

const TIMEFRAME = '1Day';
const LOOKBACK_BARS = parseInt(process.env['BACKTEST_BARS'] ?? '365', 10);
// Strategies have their own exit logic → hold until a sell signal (no timeout).
const BACKTEST_CFG = { warmupBars: 60, maxHoldBars: 0, minConfidence: 0.5, feePct: 0.001 };

const STRATEGIES: Array<{ name: string; engine: SignalEngine }> = [
  { name: 'Baseline (RSI/MACD/BB)', engine: new TechnicalSignalEngine() },
  { name: 'Trend-following', engine: new TrendFollowingEngine() },
  { name: 'Momentum', engine: new MomentumEngine() },
  { name: 'Mean-reversion', engine: new MeanReversionEngine() },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2).map((t) => t.toUpperCase());
  const universe = await new StaticUniverse().list();
  const tickers = argv.length > 0 ? argv : universe.map((i) => i.ticker);

  const data = createDataProvider();

  // Fetch each ticker's bars ONCE; reuse across all strategies.
  console.log(`Fetching ${tickers.length} ticker(s)...`);
  const datasets: Array<{ ticker: string; bars: PriceBar[] }> = [];
  for (const ticker of tickers) {
    const bars = await data.getBars(ticker, TIMEFRAME, LOOKBACK_BARS);
    if (bars.length > 0) datasets.push({ ticker, bars });
  }
  console.log(`Got data for ${datasets.length} ticker(s). Backtesting ${STRATEGIES.length} strategies...\n`);

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const pad = (s: string, n: number) => s.padEnd(n);
  // Order-independent, trustworthy metrics only (no cross-instrument compounding).
  console.log(
    pad('Strategy', 24) + pad('Trades', 8) + pad('Trades/yr', 11) + pad('Win%', 8) + pad('Avg/trade', 11) + 'PF'
  );
  console.log('─'.repeat(70));

  const years = LOOKBACK_BARS / 252; // ~252 trading days per year

  for (const { name, engine } of STRATEGIES) {
    const backtester = new Backtester(engine, BACKTEST_CFG);
    const results: BacktestResult[] = [];
    for (const ds of datasets) results.push(await backtester.run(ds.ticker, ds.bars));
    const m = computeBacktestMetrics(results);
    console.log(
      pad(name, 24) +
        pad(String(m.totalTrades), 8) +
        pad((m.totalTrades / years).toFixed(0), 11) +
        pad(pct(m.winRate), 8) +
        pad(pct(m.avgReturnPct), 11) +
        (m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2))
    );
  }
  console.log(
    '\nLong-only, fees 0.1%/trade, hold-until-sell. Avg/trade = expectancy per trade' +
      ' (held weeks–months). PF>1.5 with enough trades = promising.'
  );
}

main().catch((err) => {
  console.error('Comparison failed:', err);
  process.exit(1);
});
