/**
 * Record a cash deposit (or withdrawal) so the system knows how much you have
 * available to invest. Cash = deposits − buys + sells.
 *
 * Usage:
 *   npm run deposit -- 105            # deposited US$105 (≈100k CLP)
 *   npm run deposit -- 105 "aporte junio"
 *   npm run deposit -- -50            # withdrawal
 *
 * Tip: seed it once with your total funded-so-far, then add each monthly deposit.
 */
import 'dotenv/config';
import { PaperLedger } from '../src/ledger';

function main(): void {
  const [amountArg, note] = process.argv.slice(2);
  const amount = parseFloat(amountArg ?? '');
  if (!Number.isFinite(amount) || amount === 0) {
    console.error('Usage: npm run deposit -- <amountUsd> [nota]   (negativo = retiro)');
    process.exit(1);
  }
  const ledger = new PaperLedger();
  ledger.recordDeposit(amount, new Date(), note);
  console.log(`✅ Registrado: ${amount >= 0 ? 'depósito' : 'retiro'} de US$${Math.abs(amount).toFixed(2)}`);
  console.log(`💵 Efectivo disponible ahora: US$${ledger.cashBalance().toFixed(2)}`);
  process.exit(0);
}

main();
