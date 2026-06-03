/**
 * Record a manually-executed Fintual fill into the paper ledger, so the system
 * can reconcile it against the recommendation and track paper performance.
 *
 * Usage: npm run fill -- <recommendationId> <ticker> <price> <shares>
 */
import 'dotenv/config';
import { PaperLedger } from '../src/ledger';

function main(): void {
  const [recId, ticker, price, shares] = process.argv.slice(2);
  if (!recId || !ticker || !price || !shares) {
    console.error('Usage: npm run fill -- <recommendationId> <ticker> <price> <shares>');
    process.exit(1);
  }
  const filledPrice = parseFloat(price);
  const filledShares = parseFloat(shares);
  if (!Number.isFinite(filledPrice) || !Number.isFinite(filledShares)) {
    console.error('price and shares must be numbers');
    process.exit(1);
  }

  new PaperLedger().recordFill({
    recommendationId: recId,
    ticker: ticker.toUpperCase(),
    filledPrice,
    shares: filledShares,
    filledAt: new Date(),
  });
  console.log(`✅ Fill registrado: ${filledShares} ${ticker.toUpperCase()} @ $${filledPrice} (rec ${recId})`);
}

main();
