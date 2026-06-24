import { Ledger } from '../ledger';
import { MarketDataProvider } from '../data';

/** One open holding with cost basis and live valuation. */
export interface Holding {
  ticker: string;
  shares: number;
  entryPrice: number;
  currentPrice: number | null;
  costUsd: number;
  valueUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
}

/** Current paper portfolio: holdings + totals (the "saldo"). */
export interface PortfolioSummary {
  holdings: Holding[];
  totalCostUsd: number;
  totalValueUsd: number; // market value of holdings
  totalPnlUsd: number;
  totalPnlPct: number | null;
  /** Available cash to invest (deposits − buys + sells). */
  cashUsd: number;
  /** Account value = cash + holdings value. */
  accountValueUsd: number;
}

/**
 * Build the current paper portfolio from the ledger's open positions, valued at
 * the latest prices. This is the "saldo actual" shown in the consolidated plan.
 */
export async function buildPortfolio(
  ledger: Ledger,
  data: MarketDataProvider
): Promise<PortfolioSummary> {
  const positions = ledger.openPositions();
  const holdings: Holding[] = [];
  let totalCostUsd = 0;
  let totalValueUsd = 0;

  for (const p of positions) {
    const currentPrice = await data.getLatestPrice(p.ticker).catch(() => null);
    const costUsd = p.shares * p.entryPrice;
    const valueUsd = currentPrice != null ? p.shares * currentPrice : null;
    const pnlUsd = valueUsd != null ? valueUsd - costUsd : null;
    const pnlPct = pnlUsd != null && costUsd > 0 ? pnlUsd / costUsd : null;

    holdings.push({ ticker: p.ticker, shares: p.shares, entryPrice: p.entryPrice, currentPrice, costUsd, valueUsd, pnlUsd, pnlPct });
    totalCostUsd += costUsd;
    totalValueUsd += valueUsd ?? costUsd; // fall back to cost when price unavailable
  }

  const totalPnlUsd = totalValueUsd - totalCostUsd;
  const totalPnlPct = totalCostUsd > 0 ? totalPnlUsd / totalCostUsd : null;
  const cashUsd = ledger.cashBalance();

  return {
    holdings,
    totalCostUsd,
    totalValueUsd,
    totalPnlUsd,
    totalPnlPct,
    cashUsd,
    accountValueUsd: cashUsd + totalValueUsd,
  };
}
