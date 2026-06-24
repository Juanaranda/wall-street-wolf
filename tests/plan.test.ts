import { buildPortfolio } from '../src/compound/portfolio';
import { formatPlan } from '../src/compound/plan';
import { Ledger } from '../src/ledger';
import { MarketDataProvider } from '../src/data';
import { Recommendation, PaperPosition } from '../src/shared/types';

function ledgerWith(positions: PaperPosition[]): Ledger {
  return {
    recordRecommendation: () => {},
    recordFill: () => {},
    openPositions: () => positions,
    getRecommendations: () => [],
    getFills: () => [],
    recordDeposit: () => {},
    getDeposits: () => [],
    cashBalance: () => 0,
  };
}

const data = (prices: Record<string, number | null>): MarketDataProvider => ({
  getBars: async () => [],
  getLatestPrice: async (t: string) => prices[t] ?? null,
});

describe('buildPortfolio', () => {
  it('values holdings and totals P&L', async () => {
    const ledger = ledgerWith([
      { ticker: 'CAT', shares: 0.024, entryPrice: 900, openedAt: new Date() }, // cost 21.6
      { ticker: 'MRK', shares: 0.075, entryPrice: 120, openedAt: new Date() }, // cost 9.0
    ]);
    const p = await buildPortfolio(ledger, data({ CAT: 1000, MRK: 120 }));

    expect(p.holdings).toHaveLength(2);
    const cat = p.holdings.find((h) => h.ticker === 'CAT')!;
    expect(cat.valueUsd).toBeCloseTo(24, 3); // 0.024 * 1000
    expect(cat.pnlUsd).toBeCloseTo(2.4, 3); // 24 - 21.6
    expect(p.totalCostUsd).toBeCloseTo(30.6, 3);
    expect(p.totalValueUsd).toBeCloseTo(33, 3);
    expect(p.totalPnlUsd).toBeCloseTo(2.4, 3);
  });

  it('falls back to cost when a price is unavailable', async () => {
    const ledger = ledgerWith([{ ticker: 'XYZ', shares: 1, entryPrice: 50, openedAt: new Date() }]);
    const p = await buildPortfolio(ledger, data({ XYZ: null }));
    expect(p.holdings[0]!.valueUsd).toBeNull();
    expect(p.totalValueUsd).toBeCloseTo(50, 3); // fell back to cost
  });
});

describe('formatPlan', () => {
  const portfolio = {
    holdings: [{ ticker: 'CAT', shares: 0.024, entryPrice: 900, currentPrice: 1000, costUsd: 21.6, valueUsd: 24, pnlUsd: 2.4, pnlPct: 0.111 }],
    totalCostUsd: 21.6,
    totalValueUsd: 24,
    totalPnlUsd: 2.4,
    totalPnlPct: 0.111,
    cashUsd: 50,
    accountValueUsd: 74,
  };

  it('consolidates balance + buys + sells in one message', () => {
    const recs: Recommendation[] = [
      { id: '1', ticker: 'AMD', action: 'buy', suggestedAmountUsd: 10, confidence: 0.9, rationale: 'momentum', createdAt: new Date() },
      { id: '2', ticker: 'GS', action: 'sell', suggestedAmountUsd: 9, confidence: 0.8, rationale: 'momentum faded. Vender tus 0.01 acciones', createdAt: new Date() },
    ];
    const msg = formatPlan(recs, portfolio, new Date('2026-06-10'));
    expect(msg).toContain('Plan de inversión (2026-06-10)');
    expect(msg).toContain('Tu cartera (saldo actual)');
    expect(msg).toContain('CAT');
    expect(msg).toContain('COMPRAR hoy');
    expect(msg).toContain('AMD');
    expect(msg).toContain('VENDER hoy');
    expect(msg).toContain('GS');
  });

  it('shows placeholders when there is nothing to do', () => {
    const empty = { holdings: [], totalCostUsd: 0, totalValueUsd: 0, totalPnlUsd: 0, totalPnlPct: null, cashUsd: 0, accountValueUsd: 0 };
    const msg = formatPlan([], empty);
    expect(msg).toContain('sin nuevas compras');
    expect(msg).toContain('sin ventas');
    expect(msg).toContain('aún sin posiciones');
  });
});
