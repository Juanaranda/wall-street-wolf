/**
 * Send the weekly review summary now (track record + calibration + lessons) via
 * WhatsApp (or console). The scheduler also sends this automatically on Sundays.
 *
 * Usage: npm run weekly-review
 */
import 'dotenv/config';
import { PaperLedger } from '../src/ledger';
import { createDataProvider } from '../src/data';
import { createNotifier } from '../src/notify';
import { SignalReviewer } from '../src/compound/signal-review';
import { sendWeeklyReview } from '../src/compound/weekly-review';

async function main(): Promise<void> {
  const reviewer = new SignalReviewer(new PaperLedger(), createDataProvider());
  const message = await sendWeeklyReview(reviewer, createNotifier());
  console.log('\n' + message + '\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('weekly-review failed:', err);
  process.exit(1);
});
