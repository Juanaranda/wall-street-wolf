/**
 * tests/strategy-trend.test.ts
 *
 * Unit tests for TrendFollowingEngine.
 * All price series are synthetic — no network calls, no external deps.
 *
 * Scenarios covered:
 *   1. Confirmed uptrend  → buy
 *   2. Trend breakdown    → sell (price < SMA50)
 *   3. Death cross        → sell (SMA50 <= SMA200)
 *   4. Choppy / sideways  → hold
 *   5. Insufficient data  → hold (< 200 bars)
 *   6. Exactly 200 bars   → produces a real signal (not the "insufficient data" hold)
 *   7. strength / confidence are in [0, 1]
 *   8. reasons are always populated
 *   9. timestamp is approximately now
 */

import { TrendFollowingEngine } from '../src/signals/strategies/trend-following';
import { PriceBar } from '../src/shared/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBar(ticker: string, close: number, dayIndex: number): PriceBar {
  return {
    ticker,
    timestamp: new Date(2020, 0, dayIndex + 1),
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: 1_000_000,
  };
}

function buildSeries(count: number, priceFn: (i: number) => number, ticker = 'TEST'): PriceBar[] {
  return Array.from({ length: count }, (_, i) => makeBar(ticker, priceFn(i), i));
}

// ─── Synthetic series factories ───────────────────────────────────────────────

/**
 * CONFIRMED UPTREND:
 *   350 bars of steadily rising price.
 *   The linear slope means that by bar 350:
 *     price ≈ 135  >  SMA200 ≈ 100  >  SMA50 ≈ 120  — golden cross holds.
 *
 * Starting price 50, +0.25 / bar → price[349] ≈ 137.25
 * SMA50  ≈ avg of bars 300-349 → mid ≈ 125
 * SMA200 ≈ avg of bars 150-349 → mid ≈ 100
 * price > SMA50 > SMA200 → buy
 */
function uptrendSeries(): PriceBar[] {
  return buildSeries(350, (i) => 50 + i * 0.25);
}

/**
 * TREND BREAKDOWN (price < SMA50):
 *   300 bars of uptrend (establishes golden cross) then 60 bars of sharp decline.
 *   After the decline price sits well below SMA50 → sell.
 */
function trendBreakSeries(): PriceBar[] {
  return buildSeries(360, (i) => {
    if (i < 300) return 50 + i * 0.25;           // uptrend: 50 → 124.75
    return 124.75 - (i - 300) * 1.5;             // sharp drop: each bar -1.5
  });
}

/**
 * DEATH CROSS (SMA50 crosses below SMA200):
 *   400 bars: first 200 bars flat at 100 (SMA200 ≈ 100),
 *   then 200 bars of steep decline — by the end SMA50 is well below SMA200.
 */
function deathCrossSeries(): PriceBar[] {
  return buildSeries(400, (i) => {
    if (i < 200) return 100;
    return 100 - (i - 200) * 0.5;   // decline: -0.5/bar
  });
}

/**
 * CHOPPY / SIDEWAYS — tight oscillation around 100.
 *   350 bars with amplitude ±0.01.  SMA50 ≈ SMA200 ≈ 100 and the spread
 *   between them never exceeds MIN_SPREAD_PCT (0.5 %), so the engine sits
 *   in the neutral deadband and returns hold.
 */
function choppySeries(): PriceBar[] {
  // Amplitude 0.01 → spread << 0.005 * 100 = 0.5 → always in deadband
  return buildSeries(350, (i) => 100 + Math.sin(i * 0.3) * 0.01);
}

/**
 * INSUFFICIENT DATA — fewer than 200 bars.
 */
function shortSeries(count = 150): PriceBar[] {
  return buildSeries(count, (i) => 50 + i * 0.25);
}

/**
 * EXACTLY 200 bars — the minimum threshold.
 */
function exactlyMinSeries(): PriceBar[] {
  return buildSeries(200, (i) => 50 + i * 0.25);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TrendFollowingEngine', () => {
  const engine = new TrendFollowingEngine();

  // ── Insufficient data ─────────────────────────────────────────────────────

  describe('insufficient data', () => {
    it('returns hold for empty series', async () => {
      const signal = await engine.evaluate('AAPL', []);
      expect(signal.action).toBe('hold');
      expect(signal.confidence).toBe(0);
      expect(signal.strength).toBe(0);
      expect(signal.reasons.some((r) => r.includes('insufficient data'))).toBe(true);
    });

    it('returns hold for series with fewer than 200 bars', async () => {
      const signal = await engine.evaluate('AAPL', shortSeries(150));
      expect(signal.action).toBe('hold');
      expect(signal.confidence).toBe(0);
      expect(signal.strength).toBe(0);
      expect(signal.reasons.some((r) => r.includes('insufficient data'))).toBe(true);
    });

    it('mentions how many bars are available in the insufficient-data reason', async () => {
      const signal = await engine.evaluate('TEST', shortSeries(100));
      expect(signal.reasons[0]).toMatch(/have 100/);
    });
  });

  // ── Uptrend → buy ─────────────────────────────────────────────────────────

  describe('confirmed uptrend', () => {
    it('emits buy for a steady uptrend series (350 bars)', async () => {
      const signal = await engine.evaluate('UP', uptrendSeries());
      expect(signal.action).toBe('buy');
    });

    it('buy signal mentions SMA50 > SMA200 (golden-cross) in reasons', async () => {
      const signal = await engine.evaluate('UP', uptrendSeries());
      expect(signal.reasons.some((r) => r.includes('SMA50') && r.includes('SMA200'))).toBe(true);
    });

    it('buy signal mentions price > SMA50 in reasons', async () => {
      const signal = await engine.evaluate('UP', uptrendSeries());
      expect(signal.reasons.some((r) => r.includes('SMA50') && r.includes('uptrend'))).toBe(true);
    });

    it('buy signal strength is in (0, 1]', async () => {
      const signal = await engine.evaluate('UP', uptrendSeries());
      expect(signal.strength).toBeGreaterThan(0);
      expect(signal.strength).toBeLessThanOrEqual(1);
    });

    it('buy signal confidence is in (0, 1]', async () => {
      const signal = await engine.evaluate('UP', uptrendSeries());
      expect(signal.confidence).toBeGreaterThan(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
    });
  });

  // ── Trend break → sell ────────────────────────────────────────────────────

  describe('trend breakdown — price < SMA50', () => {
    it('emits sell when price falls below SMA50', async () => {
      const signal = await engine.evaluate('BREAK', trendBreakSeries());
      expect(signal.action).toBe('sell');
    });

    it('sell reason mentions price < SMA50', async () => {
      const signal = await engine.evaluate('BREAK', trendBreakSeries());
      expect(signal.reasons.some((r) => r.includes('SMA50') && r.includes('trend break'))).toBe(true);
    });

    it('sell strength is > 0', async () => {
      const signal = await engine.evaluate('BREAK', trendBreakSeries());
      expect(signal.strength).toBeGreaterThan(0);
    });
  });

  // ── Death cross → sell ────────────────────────────────────────────────────

  describe('death cross — SMA50 <= SMA200', () => {
    it('emits sell when SMA50 crosses below SMA200', async () => {
      const signal = await engine.evaluate('DEATH', deathCrossSeries());
      expect(signal.action).toBe('sell');
    });

    it('sell reason mentions golden cross broken', async () => {
      const signal = await engine.evaluate('DEATH', deathCrossSeries());
      expect(
        signal.reasons.some((r) => r.includes('golden cross broken'))
      ).toBe(true);
    });
  });

  // ── Choppy / neutral → hold (deadband) ───────────────────────────────────

  describe('choppy / sideways market (deadband)', () => {
    it('emits hold when the SMA50/SMA200 spread is within the neutral deadband', async () => {
      const signal = await engine.evaluate('CHOP', choppySeries());
      expect(signal.action).toBe('hold');
    });

    it('choppy hold has strength=0 and confidence=0', async () => {
      const signal = await engine.evaluate('CHOP', choppySeries());
      expect(signal.strength).toBe(0);
      expect(signal.confidence).toBe(0);
    });

    it('choppy hold reason mentions deadband', async () => {
      const signal = await engine.evaluate('CHOP', choppySeries());
      expect(signal.reasons.some((r) => r.includes('deadband') || r.includes('neutral'))).toBe(true);
    });
  });

  // ── Boundary: exactly 200 bars ────────────────────────────────────────────

  describe('boundary: exactly 200 bars', () => {
    it('does NOT return the "insufficient data" hold', async () => {
      const signal = await engine.evaluate('MIN', exactlyMinSeries());
      expect(signal.reasons.some((r) => r.includes('insufficient data'))).toBe(false);
    });

    it('returns a valid action', async () => {
      const signal = await engine.evaluate('MIN', exactlyMinSeries());
      expect(['buy', 'sell', 'hold']).toContain(signal.action);
    });
  });

  // ── Invariants (all signals) ──────────────────────────────────────────────

  describe('invariants across all signals', () => {
    const allSeries = [
      { label: 'uptrend', bars: uptrendSeries() },
      { label: 'trend break', bars: trendBreakSeries() },
      { label: 'death cross', bars: deathCrossSeries() },
      { label: 'choppy', bars: choppySeries() },
      { label: 'short', bars: shortSeries() },
      { label: 'empty', bars: [] },
    ];

    for (const { label, bars } of allSeries) {
      it(`strength ∈ [0, 1] for "${label}"`, async () => {
        const signal = await engine.evaluate('INV', bars);
        expect(signal.strength).toBeGreaterThanOrEqual(0);
        expect(signal.strength).toBeLessThanOrEqual(1);
      });

      it(`confidence ∈ [0, 1] for "${label}"`, async () => {
        const signal = await engine.evaluate('INV', bars);
        expect(signal.confidence).toBeGreaterThanOrEqual(0);
        expect(signal.confidence).toBeLessThanOrEqual(1);
      });

      it(`reasons array is non-empty for "${label}"`, async () => {
        const signal = await engine.evaluate('INV', bars);
        expect(signal.reasons.length).toBeGreaterThan(0);
      });

      it(`ticker is echoed back for "${label}"`, async () => {
        const signal = await engine.evaluate('MYTICKER', bars);
        expect(signal.ticker).toBe('MYTICKER');
      });
    }
  });

  // ── Timestamp ─────────────────────────────────────────────────────────────

  it('sets timestamp to approximately now', async () => {
    const before = Date.now();
    const signal = await engine.evaluate('TS', uptrendSeries());
    const after = Date.now();
    expect(signal.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(signal.timestamp.getTime()).toBeLessThanOrEqual(after + 5);
  });

  // ── NEVER throws ──────────────────────────────────────────────────────────

  it('never throws for any input (edge: 1 bar)', async () => {
    await expect(engine.evaluate('SAFE', [makeBar('SAFE', 100, 0)])).resolves.toBeDefined();
  });

  it('never throws for NaN-valued bars (graceful hold)', async () => {
    const weirdBars = buildSeries(10, () => NaN);
    await expect(engine.evaluate('NAN', weirdBars)).resolves.toBeDefined();
  });
});
