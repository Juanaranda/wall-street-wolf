import { SignalReviewer } from '../src/compound/signal-review';
import { Recommendation, PaperPosition } from '../src/shared/types';
import { Ledger } from '../src/ledger';
import { MarketDataProvider } from '../src/data';

const rec = (ticker: string, confidence: number): Recommendation => ({
  id: ticker, ticker, action: 'buy', suggestedAmountUsd: 100, confidence, rationale: 'mom', createdAt: new Date(),
});
const pos = (ticker: string, entryPrice: number): PaperPosition => ({ ticker, shares: 1, entryPrice, openedAt: new Date() });

function ledgerWith(positions: PaperPosition[], recs: Recommendation[]): Ledger {
  return {
    recordRecommendation: () => {},
    recordFill: () => {},
    openPositions: () => positions,
    getRecommendations: () => recs,
    getFills: () => [],
    recordDeposit: () => {},
    getDeposits: () => [],
    cashBalance: () => 0,
  };
}

// AAA winner (+10%, conf 0.9), BBB loser (-10%, conf 0.6).
const prices: Record<string, number> = { AAA: 110, BBB: 90 };
const data: MarketDataProvider = {
  getBars: async () => [],
  getLatestPrice: async (t: string) => prices[t] ?? null,
};

describe('SignalReviewer (position-based)', () => {
  const ledger = ledgerWith([pos('AAA', 100), pos('BBB', 100)], [rec('AAA', 0.9), rec('BBB', 0.6)]);

  it('evaluates real holdings (winner / loser) with attached confidence', async () => {
    const reviews = await new SignalReviewer(ledger, data).review();
    const byTicker = Object.fromEntries(reviews.map((r) => [r.ticker, r]));
    expect(byTicker['AAA']!.win).toBe(true);
    expect(byTicker['AAA']!.returnPct).toBeCloseTo(0.1, 6);
    expect(byTicker['AAA']!.confidence).toBeCloseTo(0.9, 6);
    expect(byTicker['BBB']!.win).toBe(false);
    expect(byTicker['BBB']!.lesson).toContain('BBB');
  });

  it('summarizes win rate, P&L, calibration and lessons', async () => {
    const r = await new SignalReviewer(ledger, data).summarize();
    expect(r.positions).toBe(2);
    expect(r.evaluated).toBe(2);
    expect(r.winRate).toBeCloseTo(0.5, 6);
    expect(r.totalPnlUsd).toBeCloseTo(0, 6); // +10 and -10
    expect(r.recommendationsOnRecord).toBe(2);

    const hi = r.calibration.find((b) => b.range.startsWith('0.85'))!;
    expect(hi.n).toBe(1);
    expect(hi.winRate).toBe(1); // AAA conf 0.9 won
    const lo = r.calibration.find((b) => b.range.startsWith('0.50'))!;
    expect(lo.winRate).toBe(0); // BBB conf 0.6 lost

    expect(r.lessons.some((l) => l.includes('Cartera'))).toBe(true);
    expect(r.lessons.some((l) => l.includes('En rojo'))).toBe(true);
  });

  it('handles an empty portfolio gracefully', async () => {
    const r = await new SignalReviewer(ledgerWith([], []), data).summarize();
    expect(r.positions).toBe(0);
    expect(r.winRate).toBeNull();
    expect(r.lessons[0]).toContain('Aún no tienes posiciones');
  });
});
