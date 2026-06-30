/**
 * Generate trading signals NOW (one pipeline cycle) and print/notify them.
 * Uses momentum over the warehouse data, sizes for Fintual, records to the paper
 * ledger, and sends via WhatsApp (if Twilio env is set) or console otherwise.
 *
 * Usage: npm run signal
 */
import 'dotenv/config';
import { SignalOrchestrator } from '../src/orchestrator';

async function main(): Promise<void> {
  const orchestrator = new SignalOrchestrator();
  await orchestrator.initialize();
  const recs = await orchestrator.runCycle();

  if (recs.length === 0) {
    console.log('\nNo actionable signals this cycle. (Nada que comprar hoy — está bien.)');
  } else {
    console.log(`\n📲 ${recs.length} señal(es) — ejecuta manual en Fintual:\n`);
    for (const r of recs) {
      const verb = r.action === 'sell' ? '🔴 VENDER' : '🟢 COMPRAR';
      const tag = r.horizon ? ` [${r.horizon}${r.strategy ? ` · ${r.strategy}` : ''}]` : '';
      console.log(
        ` • ${verb} ${r.ticker}${tag}  ~US$${r.suggestedAmountUsd}  ` +
          `(confianza ${(r.confidence * 100).toFixed(0)}%)\n     ${r.rationale}\n     id: ${r.id}`
      );
    }
    console.log('\nCuando ejecutes, registra el fill: npm run fill -- <id> <ticker> <precio> <acciones>');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('signal failed:', err);
  process.exit(1);
});
