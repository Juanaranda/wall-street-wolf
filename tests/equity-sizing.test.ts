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

  it('never goes below the minimum', () => {
    const tiny = sizePosition(0.1, { ...cfg, bankrollUsd: 100 });
    expect(tiny).toBe(50);
  });

  it('clamps out-of-range confidence', () => {
    expect(sizePosition(5, cfg)).toBe(sizePosition(1, cfg));
    expect(sizePosition(-1, cfg)).toBe(sizePosition(0, cfg));
  });
});
