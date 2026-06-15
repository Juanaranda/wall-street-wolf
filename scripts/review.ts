/**
 * Review the system's REAL recommendations: realized performance, confidence
 * calibration, and distilled lessons from the paper ledger. (Outcome 4 / #12.)
 *
 * Usage: npm run review
 */
import 'dotenv/config';
import { PaperLedger } from '../src/ledger';
import { createDataProvider } from '../src/data';
import { SignalReviewer } from '../src/compound/signal-review';

async function main(): Promise<void> {
  const reviewer = new SignalReviewer(new PaperLedger(), createDataProvider());
  const r = await reviewer.summarize();

  const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);

  console.log('\n═══ Signal Review (track record real) ═══');
  console.log(`Posiciones: ${r.positions}   Evaluadas: ${r.evaluated}   (recomendaciones en registro: ${r.recommendationsOnRecord})`);
  console.log(`Win rate: ${pct(r.winRate)}   Retorno medio: ${pct(r.avgReturnPct)}   P&L: US$${r.totalPnlUsd.toFixed(2)}`);

  console.log('\nCalibración (¿más confianza = más aciertos?):');
  for (const b of r.calibration) {
    console.log(`  conf ${b.range}   n=${b.n}\twin=${pct(b.winRate)}\tavg=${pct(b.avgReturnPct)}`);
  }

  console.log('\nLecciones:');
  for (const l of r.lessons) console.log(`  • ${l}`);
  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error('review failed:', err);
  process.exit(1);
});
