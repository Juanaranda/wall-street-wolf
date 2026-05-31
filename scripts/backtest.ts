/**
 * Backtest runner — wires universe + Alpaca data + signal engine + backtester
 * and prints an honest performance + calibration report.
 *
 * Usage:
 *   npm run backtest                 # backtest the whole universe (1Y daily)
 *   npm run backtest -- SQM AAPL     # backtest specific tickers
 *
 * Requires ALPACA_API_KEY / ALPACA_API_SECRET in .env for real data
 * (free Alpaca data account). Without keys it runs but fetches no bars.
 */
import 'dotenv/config';
import { StaticUniverse } from '../src/universe';
import { AlpacaDataProvider } from '../src/data';
import { TechnicalSignalEngine } from '../src/signals';
import { Backtester, computeBacktestMetrics, formatBacktestReport } from '../src/backtest';
import { BacktestResult } from '../src/backtest/types';

const TIMEFRAME = '1Day';
const LOOKBACK_BARS = 365;

async function main(): Promise<void> {
  const argv = process.argv.slice(2).map((t) => t.toUpperCase());

  const universe = await new StaticUniverse().list();
  const tickers = argv.length > 0 ? argv : universe.map((i) => i.ticker);

  const data = new AlpacaDataProvider(
    process.env['ALPACA_API_KEY'] ?? '',
    process.env['ALPACA_API_SECRET'] ?? ''
  );
  const backtester = new Backtester(new TechnicalSignalEngine());

  console.log(`Backtesting ${tickers.length} instrument(s) over ~${LOOKBACK_BARS} daily bars...\n`);

  const results: BacktestResult[] = [];
  for (const ticker of tickers) {
    const bars = await data.getBars(ticker, TIMEFRAME, LOOKBACK_BARS);
    if (bars.length === 0) {
      console.log(`  ${ticker}: no data (check ALPACA keys) — skipped`);
      continue;
    }
    const result = await backtester.run(ticker, bars);
    results.push(result);
    console.log(`  ${ticker}: ${result.trades.length} trade(s) over ${bars.length} bars`);
  }

  console.log('\n' + formatBacktestReport(computeBacktestMetrics(results)));
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
