/**
 * ETL: bronze (price_bars) → silver (features) → gold (training_examples).
 *
 * Reads raw bars from the Postgres warehouse, computes point-in-time features
 * (no lookahead), labels forward returns, and persists both layers for fast
 * ML/analysis. Idempotent — safe to re-run.
 *
 * Usage:
 *   npm run etl                                   # whole universe
 *   npm run etl -- SQM AAPL
 *   LABEL_HORIZON=21 TRAIN_END=2016-01-01 npm run etl
 *
 * Requires DATABASE_URL and a populated price_bars table (run `npm run ingest` first).
 */
import 'dotenv/config';
import { StaticUniverse } from '../src/universe';
import { PostgresBarStore } from '../src/data';
import { computeFeatures, buildTrainingExamples } from '../src/etl/features';
import { PostgresFeatureStore } from '../src/etl/feature-store';

const HORIZON = parseInt(process.env['LABEL_HORIZON'] ?? '21', 10); // ~1 month forward
const TRAIN_END = new Date(process.env['TRAIN_END'] ?? '2016-01-01');
const MAX_BARS = parseInt(process.env['ETL_BARS'] ?? '6000', 10);

async function main(): Promise<void> {
  if (!process.env['DATABASE_URL']) {
    console.error('DATABASE_URL not set.');
    process.exit(1);
  }
  const argv = process.argv.slice(2).map((t) => t.toUpperCase());
  const universe = await new StaticUniverse().list();
  const tickers = argv.length > 0 ? argv : universe.map((i) => i.ticker);

  const barStore = new PostgresBarStore();
  const featStore = new PostgresFeatureStore();

  console.log(
    `ETL ${tickers.length} ticker(s): horizon=${HORIZON}d, train<${TRAIN_END.toISOString().slice(0, 10)}\n`
  );

  let totalFeats = 0;
  let totalEx = 0;
  for (const ticker of tickers) {
    const bars = await barStore.getRecentBars(ticker, '1Day', MAX_BARS);
    if (bars.length === 0) {
      console.log(`  ${ticker.padEnd(6)} no bars — skipped`);
      continue;
    }
    const feats = computeFeatures(ticker, bars);
    const nf = await featStore.upsertFeatures(feats);
    const examples = buildTrainingExamples(bars, feats, HORIZON, TRAIN_END);
    const ng = await featStore.upsertTrainingExamples(examples);
    totalFeats += nf;
    totalEx += ng;
    console.log(`  ${ticker.padEnd(6)} ${String(nf).padStart(5)} features  ${String(ng).padStart(5)} labelled`);
  }

  const trainN = await featStore.count('training_examples', 'train');
  const testN = await featStore.count('training_examples', 'test');
  console.log(`\nDone. ${totalFeats} features, ${totalEx} training examples (train ${trainN} / test ${testN}).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('ETL failed:', err);
  process.exit(1);
});
