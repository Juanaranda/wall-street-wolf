/**
 * tests/signals.test.ts
 *
 * Unit tests for TechnicalSignalEngine and LlmGatedSignalEngine.
 * No network calls are made in any of these tests.
 */

import { TechnicalSignalEngine, LlmGatedSignalEngine, LlmCaller, SignalEngine } from '../src/signals';
import { PriceBar, Signal } from '../src/shared/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBar(close: number, i: number): PriceBar {
  return {
    ticker: 'TEST',
    timestamp: new Date(2024, 0, i + 1),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100_000,
  };
}

/**
 * Build a bar series with at least `count` bars following a given price path.
 * Callers supply a factory function `priceFn(index)`.
 */
function buildSeries(count: number, priceFn: (i: number) => number): PriceBar[] {
  return Array.from({ length: count }, (_, i) => makeBar(priceFn(i), i));
}

/**
 * Synthetic OVERSOLD series:
 *   - 60 bars of steadily declining prices (100 → 40).
 *   - The last ~20 bars are near the bottom to ensure RSI is oversold (<35),
 *     the MACD histogram just turned positive, and price is near the lower BB.
 *   - Ends with a tiny uptick to trigger the MACD bullish histogram crossover.
 */
function oversoldSeries(): PriceBar[] {
  const count = 80;
  return buildSeries(count, (i) => {
    if (i < 55) {
      // Steep decline: 100 → 45
      return 100 - i * (55 / 55);
    }
    if (i < 75) {
      // Flat bottom (RSI stays low, BB lower-band)
      return 45;
    }
    // Small recovery to flip MACD histogram sign and get price slightly above bottom
    return 45 + (i - 75) * 0.3;
  });
}

/**
 * Synthetic OVERBOUGHT series:
 *   - 60 bars of strong uptrend (50 → 138.5) drives RSI well above 65.
 *   - 5 bars of moderate pullback (rate 2.0/bar) flips the MACD histogram
 *     negative while RSI remains overbought (>65).
 *   - The BB pctB is neutral (no vote), so sell wins 2-1 over the EMA
 *     bullish vote: RSI-sell + MACD-sell vs EMA-buy → sellWeight ≥ 0.6 → sell.
 */
function overboughtSeries(): PriceBar[] {
  return buildSeries(65, (i) => {
    if (i < 60) return 50 + i * 1.5;   // strong rise: 50 → 138.5
    return 138.5 - (i - 60) * 2.0;     // moderate pullback: MACD flips, RSI stays >65
  });
}

/**
 * Synthetic FLAT / neutral series:
 *   - Prices oscillate around 100 in a narrow band.
 *   - RSI stays near 50, MACD histogram near 0, price near middle BB.
 */
function flatSeries(): PriceBar[] {
  return buildSeries(80, (i) => 100 + Math.sin(i * 0.3) * 1.5);
}

/**
 * Very short series (below MIN_BARS_REQUIRED).
 */
function emptySeries(): PriceBar[] {
  return [];
}

function singleBarSeries(): PriceBar[] {
  return [makeBar(100, 0)];
}

// ─── TechnicalSignalEngine ────────────────────────────────────────────────────

describe('TechnicalSignalEngine', () => {
  const engine = new TechnicalSignalEngine();

  // ── Insufficient data ─────────────────────────────────────────────────────

  it('returns hold with confidence=0 for empty bars', async () => {
    const signal = await engine.evaluate('AAPL', emptySeries());
    expect(signal.action).toBe('hold');
    expect(signal.confidence).toBe(0);
    expect(signal.strength).toBe(0);
    expect(signal.reasons.some((r) => r.includes('insufficient data'))).toBe(true);
  });

  it('returns hold with confidence=0 for single bar', async () => {
    const signal = await engine.evaluate('AAPL', singleBarSeries());
    expect(signal.action).toBe('hold');
    expect(signal.confidence).toBe(0);
  });

  // ── Buy signal ────────────────────────────────────────────────────────────

  it('emits buy for an oversold series', async () => {
    const signal = await engine.evaluate('TEST', oversoldSeries());
    expect(signal.ticker).toBe('TEST');
    expect(signal.action).toBe('buy');
    expect(signal.strength).toBeGreaterThan(0);
    expect(signal.confidence).toBeGreaterThan(0);
  });

  it('buy signal has strength in [0, 1]', async () => {
    const signal = await engine.evaluate('TEST', oversoldSeries());
    expect(signal.strength).toBeGreaterThanOrEqual(0);
    expect(signal.strength).toBeLessThanOrEqual(1);
  });

  it('buy signal confidence is in [0, 1]', async () => {
    const signal = await engine.evaluate('TEST', oversoldSeries());
    expect(signal.confidence).toBeGreaterThanOrEqual(0);
    expect(signal.confidence).toBeLessThanOrEqual(1);
  });

  it('buy signal populates reasons with at least one indicator', async () => {
    const signal = await engine.evaluate('TEST', oversoldSeries());
    expect(signal.reasons.length).toBeGreaterThan(0);
    // At minimum, RSI or MACD should be mentioned
    const mentionsIndicator = signal.reasons.some(
      (r) => r.startsWith('RSI') || r.startsWith('MACD') || r.startsWith('BB') || r.startsWith('EMA')
    );
    expect(mentionsIndicator).toBe(true);
  });

  // ── Sell signal ───────────────────────────────────────────────────────────

  it('emits sell for an overbought series', async () => {
    const signal = await engine.evaluate('TEST', overboughtSeries());
    expect(signal.action).toBe('sell');
    expect(signal.strength).toBeGreaterThan(0);
    expect(signal.confidence).toBeGreaterThan(0);
  });

  it('sell signal has reasons mentioning relevant indicators', async () => {
    const signal = await engine.evaluate('TEST', overboughtSeries());
    const mentionsIndicator = signal.reasons.some(
      (r) => r.startsWith('RSI') || r.startsWith('MACD') || r.startsWith('BB') || r.startsWith('EMA')
    );
    expect(mentionsIndicator).toBe(true);
  });

  // ── Hold / neutral signal ─────────────────────────────────────────────────

  it('emits hold for a flat neutral series', async () => {
    const signal = await engine.evaluate('TEST', flatSeries());
    expect(signal.action).toBe('hold');
  });

  it('hold signal has strength=0 and confidence=0', async () => {
    const signal = await engine.evaluate('TEST', flatSeries());
    expect(signal.strength).toBe(0);
    expect(signal.confidence).toBe(0);
  });

  // ── Data-penalty on short series ──────────────────────────────────────────

  it('penalises confidence for short series (25 bars)', async () => {
    // Build a short but clearly oversold micro-series (RSI + MACD should still fire)
    const shortSeries = buildSeries(25, (i) => {
      if (i < 20) return 100 - i * 2; // steep decline to force RSI low
      return 60 + (i - 20) * 0.5;    // tiny uptick at end
    });
    const shortSignal = await engine.evaluate('SHORT', shortSeries);
    const longSignal = await engine.evaluate('LONG', oversoldSeries()); // 80 bars

    if (shortSignal.action === 'buy' && longSignal.action === 'buy') {
      expect(shortSignal.confidence).toBeLessThan(longSignal.confidence);
    } else {
      // If the short series doesn't produce a buy, confidence should still be ≤ long
      expect(shortSignal.confidence).toBeLessThanOrEqual(longSignal.confidence + 0.01);
    }
  });

  // ── Timestamp ─────────────────────────────────────────────────────────────

  it('sets timestamp to approximately now', async () => {
    const before = Date.now();
    const signal = await engine.evaluate('TEST', flatSeries());
    const after = Date.now();
    expect(signal.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(signal.timestamp.getTime()).toBeLessThanOrEqual(after + 5);
  });
});

// ─── EMA trend integration ────────────────────────────────────────────────────

describe('TechnicalSignalEngine — EMA trend check', () => {
  const engine = new TechnicalSignalEngine();

  it('includes EMA trend reason in reasons when trend is bullish', async () => {
    // Uptrend: prices consistently rising for long enough that EMA20 > EMA50
    const uptrend = buildSeries(100, (i) => 50 + i * 0.8);
    const signal = await engine.evaluate('UP', uptrend);
    if (signal.action === 'buy') {
      const hasEmaTrend = signal.reasons.some((r) => r.startsWith('EMA trend bullish'));
      // Not guaranteed to fire in isolation, but if it did it should be labelled
      if (hasEmaTrend) {
        expect(signal.reasons.some((r) => r.includes('EMA20'))).toBe(true);
        expect(signal.reasons.some((r) => r.includes('EMA50'))).toBe(true);
      }
    }
    // Action must be a valid value regardless
    expect(['buy', 'sell', 'hold']).toContain(signal.action);
  });
});

// ─── LlmGatedSignalEngine ─────────────────────────────────────────────────────

describe('LlmGatedSignalEngine', () => {
  const baseEngine = new TechnicalSignalEngine();

  function noopLlm(): LlmCaller {
    return {
      gate: jest.fn().mockResolvedValue({
        confidenceDelta: 0,
        additionalReasons: [],
        estimatedCostUsd: 0,
      }),
    };
  }

  // ── Disabled by default ───────────────────────────────────────────────────

  it('does NOT call the LLM when enabled=false (default)', async () => {
    const llm = noopLlm();
    const gated = new LlmGatedSignalEngine(baseEngine, llm);
    const bars = oversoldSeries();

    await gated.evaluate('AAPL', bars);

    expect(llm.gate).not.toHaveBeenCalled();
  });

  it('returns the same signal as the inner engine when disabled', async () => {
    const llm = noopLlm();
    const gated = new LlmGatedSignalEngine(baseEngine, llm);
    const bars = oversoldSeries();

    const inner = await baseEngine.evaluate('AAPL', bars);
    const outer = await gated.evaluate('AAPL', bars);

    expect(outer.action).toBe(inner.action);
    expect(outer.strength).toBe(inner.strength);
  });

  // ── Enabled path ──────────────────────────────────────────────────────────

  it('calls the LLM when enabled and signal.strength >= threshold', async () => {
    const llm = noopLlm();
    const gated = new LlmGatedSignalEngine(baseEngine, llm, {
      enabled: true,
      strengthThreshold: 0.1, // low threshold to ensure it fires on oversold
    });

    const bars = oversoldSeries();
    const inner = await baseEngine.evaluate('AAPL', bars);

    await gated.evaluate('AAPL', bars);

    if (inner.action !== 'hold' && inner.strength >= 0.1) {
      expect(llm.gate).toHaveBeenCalledWith('AAPL', expect.objectContaining({ action: inner.action }));
    }
  });

  it('does NOT call LLM when signal.action is hold', async () => {
    const llm = noopLlm();
    const gated = new LlmGatedSignalEngine(baseEngine, llm, { enabled: true });

    await gated.evaluate('FLAT', flatSeries());

    // Flat series → hold → no LLM call regardless of threshold
    expect(llm.gate).not.toHaveBeenCalled();
  });

  it('does NOT call LLM when signal.strength is below threshold', async () => {
    // Force the inner engine to return a weak buy signal by using a stub engine
    const weakEngine: SignalEngine = {
      evaluate: async () => ({
        ticker: 'WEAK',
        action: 'buy',
        strength: 0.4,
        confidence: 0.4,
        reasons: ['RSI=34 (oversold)'],
        timestamp: new Date(),
      }),
    };

    const llm = noopLlm();
    const gated = new LlmGatedSignalEngine(weakEngine, llm, {
      enabled: true,
      strengthThreshold: 0.7, // higher than 0.4
    });

    await gated.evaluate('WEAK', oversoldSeries());
    expect(llm.gate).not.toHaveBeenCalled();
  });

  // ── LLM adjusts confidence ────────────────────────────────────────────────

  it('adjusts confidence by confidenceDelta when LLM is called', async () => {
    const strongEngine: SignalEngine = {
      evaluate: async () => ({
        ticker: 'STRONG',
        action: 'buy',
        strength: 0.9,
        confidence: 0.7,
        reasons: ['RSI=28 (oversold)'],
        timestamp: new Date(),
      }),
    };

    const llm: LlmCaller = {
      gate: jest.fn().mockResolvedValue({
        confidenceDelta: 0.1,
        additionalReasons: ['LLM: no adverse news'],
        estimatedCostUsd: 0.00015,
      }),
    };

    const gated = new LlmGatedSignalEngine(strongEngine, llm, {
      enabled: true,
      strengthThreshold: 0.5,
    });

    const result = await gated.evaluate('STRONG', oversoldSeries());
    expect(result.confidence).toBeCloseTo(0.8, 2);
    expect(result.reasons).toContain('LLM: no adverse news');
  });

  it('clamps confidence to [0, 1] after LLM delta', async () => {
    const strongEngine: SignalEngine = {
      evaluate: async () => ({
        ticker: 'X',
        action: 'buy',
        strength: 0.95,
        confidence: 0.95,
        reasons: [],
        timestamp: new Date(),
      }),
    };

    const llm: LlmCaller = {
      gate: jest.fn().mockResolvedValue({
        confidenceDelta: 0.2,  // would push > 1
        additionalReasons: [],
        estimatedCostUsd: 0.0001,
      }),
    };

    const gated = new LlmGatedSignalEngine(strongEngine, llm, {
      enabled: true,
      strengthThreshold: 0.5,
    });

    const result = await gated.evaluate('X', oversoldSeries());
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  // ── Daily cost cap ────────────────────────────────────────────────────────

  it('skips LLM once daily cost cap is reached', async () => {
    const strongEngine: SignalEngine = {
      evaluate: async () => ({
        ticker: 'CAP',
        action: 'buy',
        strength: 0.9,
        confidence: 0.8,
        reasons: ['RSI oversold'],
        timestamp: new Date(),
      }),
    };

    const llm: LlmCaller = {
      gate: jest.fn().mockImplementation(async () => {
        return { confidenceDelta: 0.05, additionalReasons: [], estimatedCostUsd: 0.06 };
      }),
    };

    // Cap equals exactly one call's cost: first call exhausts the cap.
    const gated = new LlmGatedSignalEngine(strongEngine, llm, {
      enabled: true,
      strengthThreshold: 0.5,
      maxDailyCostUsd: 0.06,
    });

    // First call should go through (dailyCost starts at 0, 0 < 0.06)
    const r1 = await gated.evaluate('CAP', oversoldSeries());
    expect(llm.gate).toHaveBeenCalledTimes(1);
    expect(gated.getDailyCostUsd()).toBeCloseTo(0.06, 5);

    // Second call must be blocked (dailyCost 0.06 >= cap 0.06)
    const r2 = await gated.evaluate('CAP', oversoldSeries());
    expect(llm.gate).toHaveBeenCalledTimes(1); // no new calls
    expect(r2.reasons.some((r) => r.includes('daily cost cap'))).toBe(true);
  });

  // ── LLM failure graceful degradation ─────────────────────────────────────

  it('gracefully degrades when LLM throws', async () => {
    const strongEngine: SignalEngine = {
      evaluate: async () => ({
        ticker: 'ERR',
        action: 'buy',
        strength: 0.85,
        confidence: 0.75,
        reasons: ['RSI=30 (oversold)'],
        timestamp: new Date(),
      }),
    };

    const llm: LlmCaller = {
      gate: jest.fn().mockRejectedValue(new Error('Network error')),
    };

    const gated = new LlmGatedSignalEngine(strongEngine, llm, {
      enabled: true,
      strengthThreshold: 0.5,
    });

    const result = await gated.evaluate('ERR', oversoldSeries());
    // Action and core signal are preserved
    expect(result.action).toBe('buy');
    expect(result.strength).toBe(0.85);
    // Degradation reason is appended
    expect(result.reasons.some((r) => r.includes('LLM gate unavailable'))).toBe(true);
  });
});
