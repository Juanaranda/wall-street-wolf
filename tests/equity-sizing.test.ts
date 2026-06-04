import { sizePosition, SizingConfig } from '../src/risk/equity-sizing';

const cfg: SizingConfig = { bankrollUsd: 10000, basePct: 0.05, maxPct: 0.10, minUsd: 50 };

describe('sizePosition', () => {
  it('scales allocation with confidence', () => {
    const low = sizePosition(0.5, cfg);
    const high = sizePosition(1.0, cfg);
    expect(high).toBeGreaterThan(low);
    // confidence 1.0 → base 5% of 10000 = 500
    expect(high).toBe(500);
    // confidence 0.5 → scale 0.75 → 3.75% → 375
    expect(low).toBe(375);
  });

  it('never exceeds the max cap', () => {
    const big = sizePosition(1.0, { ...cfg, basePct: 0.5 }); // base would be 5000
    expect(big).toBe(1000); // capped at maxPct 10% of 10000
  });

  it('floors at the minimum when the target is below it', () => {
    // bankroll 1000, cap 100, target ~25 at conf 0 → floored to minUsd 50
    const floored = sizePosition(0, { ...cfg, bankrollUsd: 1000 });
    expect(floored).toBe(50);
  });

  it('floor never exceeds the per-position cap (small budget)', () => {
    // bankroll 100, maxPct 0.10 → cap $10; minUsd 50 must be capped to $10
    const capped = sizePosition(0, { ...cfg, bankrollUsd: 100 });
    expect(capped).toBe(10);
  });

  it('works sensibly for a US$100 starting budget', () => {
    const small = { bankrollUsd: 100, basePct: 0.05, maxPct: 0.1, minUsd: 1 };
    expect(sizePosition(1.0, small)).toBe(5); // 5% of 100
    expect(sizePosition(0.88, small)).toBeCloseTo(4.7, 2);
    expect(sizePosition(1.0, small)).toBeLessThanOrEqual(100 * 0.1); // under cap
  });

  it('clamps out-of-range confidence', () => {
    expect(sizePosition(5, cfg)).toBe(sizePosition(1, cfg));
    expect(sizePosition(-1, cfg)).toBe(sizePosition(0, cfg));
  });
});
