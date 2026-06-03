/**
 * Ingest deep price history into the local Postgres warehouse.
 *
 * Pulls ~20+ years of daily bars from Stooq (free, no API key) for the whole
 * universe and upserts them into the `price_bars` table. Run once (and re-run
 * periodically to top up recent bars).
 *
 * Usage:
 *   npm run ingest                 # whole universe
 *   npm run ingest -- SQM AAPL SPY
 *   INGEST_BARS=6000 npm run ingest
 *
 * Requires DATABASE_URL in .env.
 */
import 'dotenv/config';
import { StaticUniverse } from '../src/universe';
import { YahooDataProvider, PostgresBarStore } from '../src/data';

const TIMEFRAME = '1Day';
const BARS = parseInt(process.env['INGEST_BARS'] ?? '6000', 10); // ~24yr of daily
const DELAY_MS = 400; // be polite to Stooq

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!process.env['DATABASE_URL']) {
    console.error('DATABASE_URL not set — cannot ingest. Add it to .env.');
    process.exit(1);
  }

  const argv = process.argv.slice(2).map((t) => t.toUpperCase());
  const universe = await new StaticUniverse().list();
  const tickers = argv.length > 0 ? argv : universe.map((i) => i.ticker);

  const source = new YahooDataProvider();
  const store = new PostgresBarStore();

  console.log(`Ingesting up to ${BARS} daily bars for ${tickers.length} ticker(s) from Yahoo...\n`);

  let totalStored = 0;
  for (const ticker of tickers) {
    const bars = await source.getBars(ticker, TIMEFRAME, BARS);
    const stored = await store.upsertBars(TIMEFRAME, bars, 'stooq');
    totalStored += stored;
    const range =
      bars.length > 0
        ? `${bars[0]!.timestamp.toISOString().slice(0, 10)}→${bars[bars.length - 1]!.timestamp.toISOString().slice(0, 10)}`
        : '—';
    console.log(`  ${ticker.padEnd(6)} ${String(bars.length).padStart(5)} bars  ${range}  (stored ${stored})`);
    await sleep(DELAY_MS);
  }

  console.log(`\nDone. ${totalStored} bars in the warehouse.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
