import { Backtester } from '../src/backtest';
import { SignalEngine } from '../src/signals';
import { PriceBar, Signal } from '../src/shared/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function bar(ticker: string, i: number, close: number): PriceBar {
  return { ticker, timestamp: new Date(2024, 0, 1 + i), open: close, high: close, low: close, close, volume: 1000 };
}
function series(ticker: string, closes: number[]): PriceBar[] {
  return closes.map((c, i) => bar(ticker, i, c));
}

/** Deterministic engine: buy if last close > prev, sell if last < prev (momentum of 1). */
class LastBarEngine implements SignalEngine {
  public readonly windows: Array<{ len: number; lastClose: number }> = [];
  async evaluate(ticker: string, bars: PriceBar[]): Promise<Signal> {
    this.windows.push({ len: bars.length, lastClose: bars[bars.length - 1]!.close });
    const n = bars.length;
    if (n < 2) return { ticker, action: 'hold', strength: 0, confidence: 0, reasons: [], timestamp: new Date() };
    const action = bars[n - 1]!.close > bars[n - 2]!.close ? 'buy' : 'sell';
    return { ticker, action, strength: 1, confidence: 0.9, reasons: ['momentum'], timestamp: new Date() };
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Backtester (long-only, position-based)', () => {
  const cfg = { warmupBars: 2, maxHoldBars: 2, minConfidence: 0.6, feePct: 0 };

  it('opens a long on a buy and computes the long return', async () => {
    const bars = series('AAA', [10, 11, 12, 13, 14, 15, 16]);
    const result = await new Backtester(new LastBarEngine(), cfg).run('AAA', bars);

    expect(result.trades.length).toBeGreaterThan(0);
    const t = result.trades[0]!;
    expect(t.action).toBe('buy');
    expect(t.entryIndex).toBe(2);
    expect(t.entryPrice).toBe(12);
    // maxHoldBars=2 → exit at index 4 (close 14) via timeout
    expect(t.exitPrice).toBe(14);
    expect(t.exitReason).toBe('timeout');
    expect(t.returnPct).toBeCloseTo((14 - 12) / 12, 6);
    expect(t.win).toBe(true);
  });

  it('exits a long on a sell signal', async () => {
    const bars = series('AAA', [10, 11, 12, 11, 10]);
    const result = await new Backtester(new LastBarEngine(), { ...cfg, maxHoldBars: 0 }).run('AAA', bars);
    const t = result.trades[0]!;
    expect(t.entryIndex).toBe(2); // bought at 12
    expect(t.exitReason).toBe('sell-signal');
    expect(t.exitPrice).toBe(11);
    expect(t.win).toBe(false);
  });

  it('never shorts — every trade is a long (action "buy")', async () => {
    const bars = series('AAA', [20, 19, 18, 17, 16, 15]); // pure downtrend
    const result = await new Backtester(new LastBarEngine(), { ...cfg, maxHoldBars: 0 }).run('AAA', bars);
    // First bar with last>prev never happens → no long entries.
    expect(result.trades.every((t) => t.action === 'buy')).toBe(true);
  });

  it('NO LOOKAHEAD: each window is a true prefix of the data', async () => {
    const bars = series('AAA', [10, 11, 12, 11, 13, 12, 14, 15]);
    const engine = new LastBarEngine();
    await new Backtester(engine, cfg).run('AAA', bars);
    for (const w of engine.windows) {
      expect(w.len).toBeLessThanOrEqual(bars.length);
      // The last bar of every window matches the corresponding bar of the input —
      // i.e. the engine only ever saw past+present, never future-contaminated data.
      expect(w.lastClose).toBe(bars[w.len - 1]!.close);
    }
  });

  it('NO LOOKAHEAD: the entry decision is invariant to changes in FUTURE bars', async () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18];
    const r1 = await new Backtester(new LastBarEngine(), cfg).run('AAA', series('AAA', closes));
    const first = r1.trades[0]!;

    const mutated = [...closes];
    for (let k = first.entryIndex + 1; k < mutated.length; k++) mutated[k] = -9999;
    const r2 = await new Backtester(new LastBarEngine(), cfg).run('AAA', series('AAA', mutated));
    const firstMut = r2.trades[0]!;

    expect(firstMut.entryIndex).toBe(first.entryIndex);
    expect(firstMut.entryPrice).toBe(first.entryPrice);
    expect(firstMut.confidence).toBe(first.confidence);
  });

  it('applies fees to the long return', async () => {
    const bars = series('AAA', [10, 11, 12, 13, 14]);
    const noFee = await new Backtester(new LastBarEngine(), cfg).run('AAA', bars);
    const withFee = await new Backtester(new LastBarEngine(), { ...cfg, feePct: 0.01 }).run('AAA', bars);
    expect(withFee.trades[0]!.returnPct).toBeCloseTo(noFee.trades[0]!.returnPct - 0.01, 6);
  });

  it('produces non-overlapping positions', async () => {
    const bars = series('AAA', [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const result = await new Backtester(new LastBarEngine(), cfg).run('AAA', bars);
    for (let k = 1; k < result.trades.length; k++) {
      expect(result.trades[k]!.entryIndex).toBeGreaterThan(result.trades[k - 1]!.exitIndex);
    }
  });

  it('force-closes an open position at end of data', async () => {
    const bars = series('AAA', [10, 11, 12, 13, 14, 15, 16]);
    // maxHoldBars=0 → hold until sell; uptrend never sells → closes at end.
    const result = await new Backtester(new LastBarEngine(), { ...cfg, maxHoldBars: 0 }).run('AAA', bars);
    const last = result.trades[result.trades.length - 1]!;
    expect(last.exitReason).toBe('end-of-data');
    expect(last.exitIndex).toBe(bars.length - 1);
  });

  it('returns no trades when there is not enough data', async () => {
    const result = await new Backtester(new LastBarEngine(), cfg).run('AAA', series('AAA', [10, 11]));
    expect(result.trades).toEqual([]);
  });
});
