import { SignalReviewer } from '../src/compound/signal-review';
import { Recommendation, ManualFill, PaperPosition } from '../src/shared/types';
import { Ledger } from '../src/ledger';
import { MarketDataProvider } from '../src/data';

const rec = (id: string, ticker: string, confidence: number): Recommendation => ({
  id, ticker, action: 'buy', suggestedAmountUsd: 100, confidence, rationale: 'mom', createdAt: new Date(),
});
const fill = (id: string, ticker: string, price: number): ManualFill => ({
  recommendationId: id, ticker, filledPrice: price, shares: 1, filledAt: new Date(),
});

function ledgerWith(recs: Recommendation[], fills: ManualFill[]): Ledger {
  return {
    recordRecommendation: () => {},
    recordFill: () => {},
    openPositions: (): PaperPosition[] => [],
    getRecommendations: () => recs,
    getFills: () => fills,
  };
}

// AAA winner (+10%), BBB loser (-10%), CCC unfilled.
const prices: Record<string, number> = { AAA: 110, BBB: 90, CCC: 50 };
const data: MarketDataProvider = {
  getBars: async () => [],
  getLatestPrice: async (t: string) => prices[t] ?? null,
};

describe('SignalReviewer', () => {
  const ledger = ledgerWith(
    [rec('1', 'AAA', 0.9), rec('2', 'BBB', 0.6), rec('3', 'CCC', 0.8)],
    [fill('1', 'AAA', 100), fill('2', 'BBB', 100)]
  );

  it('classifies unfilled / winner / loser with returns', async () => {
    const reviews = await new SignalReviewer(ledger, data).review();
    const byTicker = Object.fromEntries(reviews.map((r) => [r.recommendation.ticker, r]));
    expect(byTicker['AAA']!.win).toBe(true);
    expect(byTicker['AAA']!.returnPct).toBeCloseTo(0.1, 6);
    expect(byTicker['BBB']!.win).toBe(false);
    expect(byTicker['BBB']!.lesson).toContain('BBB');
    expect(byTicker['CCC']!.status).toBe('unfilled');
  });

  it('summarizes win rate, calibration and lessons', async () => {
    const r = await new SignalReviewer(ledger, data).summarize();
    expect(r.totalRecommendations).toBe(3);
    expect(r.filled).toBe(2);
    expect(r.unfilled).toBe(1);
    expect(r.evaluated).toBe(2);
    expect(r.winRate).toBeCloseTo(0.5, 6);

    const hi = r.calibration.find((b) => b.range.startsWith('0.85'))!;
    expect(hi.n).toBe(1);
    expect(hi.winRate).toBe(1); // AAA (conf 0.9) won
    const lo = r.calibration.find((b) => b.range.startsWith('0.50'))!;
    expect(lo.winRate).toBe(0); // BBB (conf 0.6) lost

    expect(r.lessons.some((l) => l.includes('Track record'))).toBe(true);
    expect(r.lessons.some((l) => l.includes('no ejecutada'))).toBe(true);
  });

  it('handles an empty ledger gracefully', async () => {
    const r = await new SignalReviewer(ledgerWith([], []), data).summarize();
    expect(r.evaluated).toBe(0);
    expect(r.winRate).toBeNull();
    expect(r.lessons[0]).toContain('Aún no hay trades');
  });
});
