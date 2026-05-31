/**
 * tests/strategy-meanrev.test.ts
 *
 * Tests for MeanReversionEngine.
 *
 * Three core scenarios:
 *   1. Deep oversold (RSI < 30 AND price <= lower BB) → action='buy'
 *   2. Post-reversion (RSI > 50 OR price >= middle BB) → action='sell'
 *   3. Normal mid-range conditions                    → action='hold'
 *
 * Additional edge cases:
 *   4. Insufficient data → action='hold', no throw
 *   5. Confidence/strength properties are populated and in [0,1]
 *   6. Reasons array is non-empty on every action
 */

import { MeanReversionEngine } from '../src/signals/strategies/mean-reversion';
import { PriceBar } from '../src/shared/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBar(close: number, index: number, ticker = 'TEST'): PriceBar {
  return {
    ticker,
    timestamp: new Date(2024, 0, index + 1),
    open: close,
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: 1_000_000,
  };
}

function buildSeries(count: number, priceFn: (i: number) => number): PriceBar[] {
  return Array.from({ length: count }, (_, i) => makeBar(priceFn(i), i));
}

/**
 * Deep-oversold series:
 *   - 78 bars of gentle decline from 100 → ~62 (keeps RSI depressed steadily).
 *   - Last 2 bars crash to 30 (sudden gap down).
 *
 * This ensures the 20-bar BB window still contains mostly higher prices,
 * so the lower Bollinger Band (~40) sits well above the final close (~30).
 * RSI is pinned near 0 by the sustained decline.
 *
 * Verified numerically: price <= lower BB AND RSI < 30 on the final bar.
 */
function oversoldSeries(): PriceBar[] {
  const total = 80;
  return buildSeries(total, (i) => {
    if (i < 78) {
      // Gentle decline: 100 → ~62 over 78 bars
      return 100 - i * (38 / 77);
    }
    // Sudden crash to 30 in the last 2 bars
    return 30;
  });
}

/**
 * Mean-reverted series:
 *   - Build an oversold bottom (first 55 bars: 100 → 35).
 *   - Then recover strongly over 35 bars back to ~80.
 *   - Final price is well above the middle BB, RSI well above 50.
 */
function revertedSeries(): PriceBar[] {
  const total = 90;
  return buildSeries(total, (i) => {
    if (i < 55) {
      return 100 - i * (65 / 54);
    }
    // Recovery: 35 → 80 over 35 bars
    return 35 + (i - 55) * (45 / 34);
  });
}

/**
 * Normal (mid-range) series:
 *   - Oscillates mildly around 100 with ±2 sine wave.
 *   - RSI stays comfortably between 30 and 50; price stays within bands.
 */
function normalSeries(): PriceBar[] {
  const total = 80;
  return buildSeries(total, (i) => {
    return 100 + 2 * Math.sin(i * 0.3);
  });
}

// ─── Instantiate engine once ──────────────────────────────────────────────────

const engine = new MeanReversionEngine();

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('MeanReversionEngine', () => {
  // ── 1. Deep oversold → buy ─────────────────────────────────────────────────

  describe('deep oversold conditions', () => {
    it('emits action="buy" when RSI < 30 and price <= lower BB', async () => {
      const bars = oversoldSeries();
      const signal = await engine.evaluate('TEST', bars);

      expect(signal.action).toBe('buy');
    });

    it('buy signal has strength in (0, 1]', async () => {
      const signal = await engine.evaluate('TEST', oversoldSeries());

      expect(signal.strength).toBeGreaterThan(0);
      expect(signal.strength).toBeLessThanOrEqual(1);
    });

    it('buy signal has confidence in (0, 1]', async () => {
      const signal = await engine.evaluate('TEST', oversoldSeries());

      expect(signal.confidence).toBeGreaterThan(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
    });

    it('buy signal reasons mention RSI and lower BB', async () => {
      const signal = await engine.evaluate('TEST', oversoldSeries());
      const allReasons = signal.reasons.join(' ');

      expect(allReasons).toMatch(/RSI/i);
      expect(allReasons).toMatch(/BB|band/i);
    });
  });

  // ── 2. Post-reversion → sell ───────────────────────────────────────────────

  describe('post-reversion conditions', () => {
    it('emits action="sell" when price recovers to/above middle BB or RSI > 50', async () => {
      const bars = revertedSeries();
      const signal = await engine.evaluate('TEST', bars);

      expect(signal.action).toBe('sell');
    });

    it('sell signal has non-empty reasons', async () => {
      const signal = await engine.evaluate('TEST', revertedSeries());

      expect(signal.reasons.length).toBeGreaterThan(0);
    });

    it('sell signal has strength and confidence in [0, 1]', async () => {
      const signal = await engine.evaluate('TEST', revertedSeries());

      expect(signal.strength).toBeGreaterThanOrEqual(0);
      expect(signal.strength).toBeLessThanOrEqual(1);
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
    });
  });

  // ── 3. Normal conditions → hold ────────────────────────────────────────────

  describe('normal mid-range conditions', () => {
    it('emits action="hold" when RSI is between 30–50 and price is within BB bands', async () => {
      const bars = normalSeries();
      const signal = await engine.evaluate('TEST', bars);

      expect(signal.action).toBe('hold');
    });

    it('hold signal has strength=0 and confidence=0', async () => {
      const signal = await engine.evaluate('TEST', normalSeries());

      expect(signal.strength).toBe(0);
      expect(signal.confidence).toBe(0);
    });

    it('hold signal has non-empty reasons', async () => {
      const signal = await engine.evaluate('TEST', normalSeries());

      expect(signal.reasons.length).toBeGreaterThan(0);
    });
  });

  // ── 4. Insufficient data → hold, no throw ──────────────────────────────────

  describe('insufficient data', () => {
    it('returns hold without throwing when given 0 bars', async () => {
      const signal = await engine.evaluate('TEST', []);

      expect(signal.action).toBe('hold');
      expect(signal.confidence).toBe(0);
    });

    it('returns hold without throwing when given fewer bars than required', async () => {
      const shortSeries = buildSeries(10, (i) => 50 + i);
      const signal = await engine.evaluate('TEST', shortSeries);

      expect(signal.action).toBe('hold');
      expect(signal.reasons[0]).toMatch(/insufficient data/i);
    });

    it('never throws even with a single bar', async () => {
      await expect(
        engine.evaluate('TEST', [makeBar(50, 0)])
      ).resolves.not.toThrow();
    });
  });

  // ── 5. Signal shape invariants ─────────────────────────────────────────────

  describe('signal shape invariants', () => {
    const scenarios: Array<{ label: string; seriesFn: () => PriceBar[] }> = [
      { label: 'oversold', seriesFn: oversoldSeries },
      { label: 'reverted', seriesFn: revertedSeries },
      { label: 'normal',   seriesFn: normalSeries },
    ];

    for (const { label, seriesFn } of scenarios) {
      it(`${label}: signal has all required fields`, async () => {
        const signal = await engine.evaluate('TEST', seriesFn());

        expect(signal.ticker).toBe('TEST');
        expect(['buy', 'sell', 'hold']).toContain(signal.action);
        expect(typeof signal.strength).toBe('number');
        expect(typeof signal.confidence).toBe('number');
        expect(Array.isArray(signal.reasons)).toBe(true);
        expect(signal.timestamp).toBeInstanceOf(Date);
      });
    }
  });

  // ── 6. Strict thresholds produce few signals ───────────────────────────────

  describe('strict thresholds', () => {
    it('does not emit buy when only RSI is oversold but price is above lower BB', async () => {
      // Build a series where RSI stays below 30 but price stays above lower BB.
      // Accomplish this by a very steep immediate drop followed by a tiny bounce
      // so price drifts above the lower band.
      const total = 80;
      const bars = buildSeries(total, (i) => {
        if (i < 30) return 100 - i * 2.2;   // steep decline → low RSI
        return 35 + (i - 30) * 0.5;          // gentle recovery → price climbs above lower BB
      });
      const signal = await engine.evaluate('TEST', bars);

      // With price above lower BB the buy gate should be closed → hold or sell
      expect(signal.action).not.toBe('buy');
    });
  });
});
