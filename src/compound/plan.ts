import { Recommendation } from '../shared/types';
import { PortfolioSummary } from './portfolio';

const money = (n: number) => `US$${n.toFixed(2)}`;
const pct = (n: number | null) => (n === null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`);

const HORIZON_RANK: Record<string, number> = { 'corto plazo': 0, 'mediano plazo': 1, 'largo plazo': 2 };

/** Unique horizons present in the buys, sorted short→long. */
function horizonOrder(buys: { horizon?: string }[]): string[] {
  const set = [...new Set(buys.map((b) => b.horizon ?? 'otro'))];
  return set.sort((a, b) => (HORIZON_RANK[a] ?? 9) - (HORIZON_RANK[b] ?? 9));
}

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

  // ── Efectivo disponible ──
  lines.push(`💵 Efectivo disponible: ${money(portfolio.cashUsd)}  ·  🧮 Total cuenta: ${money(portfolio.accountValueUsd)}`);
  lines.push('');

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

  // ── Compras (agrupadas por horizonte) ──
  lines.push('🟢 COMPRAR hoy:');
  if (buys.length === 0) lines.push('  (sin nuevas compras)');
  else {
    for (const horizon of horizonOrder(buys)) {
      lines.push(`  [${horizon}]`);
      for (const b of buys.filter((r) => (r.horizon ?? 'otro') === horizon)) {
        const tag = b.strategy ? ` · ${b.strategy}` : '';
        lines.push(`   • ${b.ticker} ~${money(b.suggestedAmountUsd)} (conf ${(b.confidence * 100).toFixed(0)}%${tag}) — ${b.rationale}`);
      }
    }
  }
  lines.push('');

  // ── Ventas ──
  lines.push('🔴 VENDER hoy:');
  if (sells.length === 0) lines.push('  (sin ventas)');
  else for (const s of sells) lines.push(`  • ${s.ticker}${s.horizon ? ` [${s.horizon}]` : ''} — ${s.rationale}`);
  lines.push('');

  lines.push('⚠️ Sugerencias, no asesoría. Ejecuta manual en Fintual. Paper.');
  lines.push('Registra lo que ejecutes: npm run fill -- <id> <ticker> <precio> <acciones> (venta = acciones negativas)');
  return lines.join('\n');
}
