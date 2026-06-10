import { Recommendation } from '../shared/types';
import { PortfolioSummary } from './portfolio';

const money = (n: number) => `US$${n.toFixed(2)}`;
const pct = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`);

/**
 * One consolidated "investment plan" message: current balance (saldo) + all buys
 * and sells together. Replaces the old one-email-per-recommendation behaviour.
 */
export function formatPlan(
  recommendations: Recommendation[],
  portfolio: PortfolioSummary,
  now: Date = new Date()
): string {
  const buys = recommendations.filter((r) => r.action === 'buy');
  const sells = recommendations.filter((r) => r.action === 'sell');
  const lines: string[] = [`📊 Plan de inversión (${now.toISOString().slice(0, 10)})`, ''];

  // ── Saldo / cartera ──
  lines.push('💼 Tu cartera (saldo actual):');
  if (portfolio.holdings.length === 0) {
    lines.push('  (aún sin posiciones — registra tus compras con `npm run fill`)');
  } else {
    for (const h of portfolio.holdings) {
      const val = h.valueUsd != null ? money(h.valueUsd) : '—';
      lines.push(
        `  ${h.ticker.padEnd(5)} ${h.shares} acc · invertido ${money(h.costUsd)} · ahora ${val} · ${pct(h.pnlPct)}`
      );
    }
    lines.push('  ' + '─'.repeat(40));
    lines.push(
      `  Invertido ${money(portfolio.totalCostUsd)} · Valor ${money(portfolio.totalValueUsd)} · P&L ${money(portfolio.totalPnlUsd)} (${pct(portfolio.totalPnlPct)})`
    );
  }
  lines.push('');

  // ── Compras ──
  lines.push('🟢 COMPRAR hoy:');
  if (buys.length === 0) lines.push('  (sin nuevas compras)');
  else for (const b of buys) lines.push(`  • ${b.ticker} ~${money(b.suggestedAmountUsd)} (conf ${(b.confidence * 100).toFixed(0)}%) — ${b.rationale}`);
  lines.push('');

  // ── Ventas ──
  lines.push('🔴 VENDER hoy:');
  if (sells.length === 0) lines.push('  (sin ventas)');
  else for (const s of sells) lines.push(`  • ${s.ticker} — ${s.rationale}`);
  lines.push('');

  lines.push('⚠️ Sugerencias, no asesoría. Ejecuta manual en Fintual. Paper.');
  lines.push('Registra lo que ejecutes: npm run fill -- <id> <ticker> <precio> <acciones> (venta = acciones negativas)');
  return lines.join('\n');
}
