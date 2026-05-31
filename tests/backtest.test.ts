import { Backtester } from '../src/backtest';
import { SignalEngine } from '../src/signals';
import { PriceBar, Signal } from '../src/shared/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function bar(ticker: string, i: number, close: number): PriceBar {
  return {
    ticker,
    timestamp: new Date(2024, 0, 1 + i),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  };
}

function series(ticker: string, closes: number[]): PriceBar[] {
  return closes.map((c, i) => bar(ticker, i, c));
}

/** Deterministic engine: decision depends ONLY on the last two bars (momentum). */
class LastBarEngine implements SignalEngine {
  /** Records bars.length seen on each evaluate call. */
  public readonly windowLengths: number[] = [];

  async evaluate(ticker: string, bars: PriceBar[]): Promise<Signal> {
    this.windowLengths.push(bars.length);
    const n = bars.length;
    if (n < 2) {
      return { ticker, action: 'hold', strength: 0, confidence: 0, reasons: [], timestamp: new Date() };
    }
    const action = bars[n - 1]!.close > bars[n - 2]!.close ? 'buy' : 'sell';
    return { ticker, action, strength: 1, confidence: 0.9, reasons: ['momentum'], timestamp: new Date() };
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Backtester', () => {
  const cfg = { warmupBars: 2, holdingPeriodBars: 2, minConfidence: 0.6, feePct: 0 };

  it('produces simulated trades with correct buy returns', async () => {
    // Steady uptrend → buy signals win.
    const bars = series('AAA', [10, 11, 12, 13, 14, 15, 16]);
    const bt = new Backtester(new LastBarEngine(), cfg);
    const result = await bt.run('AAA', bars);

    expect(result.trades.length).toBeGreaterThan(0);
    const t = result.trades[0]!;
    expect(t.action).toBe('buy');
    // entry at index 2 (close 12), exit at index 4 (close 14) → +16.67%
    expect(t.entryPrice).toBe(12);
    expect(t.exitPrice).toBe(14);
    expect(t.returnPct).toBeCloseTo((14 - 12) / 12, 6);
    expect(t.win).toBe(true);
  });

  it('NO LOOKAHEAD: engine never receives a bar from the future', async () => {
    const bars = series('AAA', [10, 11, 12, 11, 13, 12, 14, 15]);
    const engine = new LastBarEngine();
    const bt = new Backtester(engine, cfg);
    await bt.run('AAA', bars);

    // Loop runs while i < bars.length - 1, window = bars.slice(0, i+1),
    // so the engine can see at most bars.length - 1 bars — never the final bar
    // as a "present" bar, and never anything beyond the current step.
    expect(Math.max(...engine.windowLengths)).toBeLessThanOrEqual(bars.length - 1);
  });

  it('NO LOOKAHEAD: the entry decision is invariant to changes in FUTURE bars', async () => {
    const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18];
    const original = series('AAA', closes);

    const e1 = new LastBarEngine();
    const r1 = await new Backtester(e1, cfg).run('AAA', original);
    const firstTrade = r1.trades[0]!;

    // Poison every bar AFTER the first entry index with absurd values.
    const mutatedCloses = [...closes];
    for (let k = firstTrade.entryIndex + 1; k < mutatedCloses.length; k++) {
      mutatedCloses[k] = -9999;
    }
    const e2 = new LastBarEngine();
    const r2 = await new Backtester(e2, cfg).run('AAA', series('AAA', mutatedCloses));
    const firstTradeMutated = r2.trades[0]!;

    // The ENTRY decision (index, price, action, confidence) must be identical,
    // because it only used data up to the entry bar. (Exit differs — it uses future.)
    expect(firstTradeMutated.entryIndex).toBe(firstTrade.entryIndex);
    expect(firstTradeMutated.entryPrice).toBe(firstTrade.entryPrice);
    expect(firstTradeMutated.action).toBe(firstTrade.action);
    expect(firstTradeMutated.confidence).toBe(firstTrade.confidence);
  });

  it('applies round-trip fees to returns', async () => {
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

  it('measures sell-signal quality (profits when price falls)', async () => {
    // Downtrend → sell signals, which "win" as price falls.
    const bars = series('AAA', [20, 19, 18, 17, 16, 15]);
    const result = await new Backtester(new LastBarEngine(), cfg).run('AAA', bars);
    const t = result.trades[0]!;
    expect(t.action).toBe('sell');
    expect(t.win).toBe(true);
  });

  it('returns no trades when there is not enough data', async () => {
    const bars = series('AAA', [10, 11]);
    const result = await new Backtester(new LastBarEngine(), cfg).run('AAA', bars);
    expect(result.trades).toEqual([]);
  });
});
