import { computeFeatures, buildTrainingExamples } from '../src/etl/features';
import { PriceBar } from '../src/shared/types';

function series(closes: number[]): PriceBar[] {
  return closes.map((c, i) => ({
    ticker: 'AAA',
    timestamp: new Date(2010, 0, 1 + i),
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1000,
  }));
}

// A smooth-ish rising series long enough for 252-window features.
const closes = Array.from({ length: 320 }, (_, i) => 100 + i + 5 * Math.sin(i / 7));

describe('computeFeatures', () => {
  it('returns one row per bar', () => {
    const rows = computeFeatures('AAA', series(closes));
    expect(rows).toHaveLength(closes.length);
  });

  it('computes trailing returns correctly', () => {
    const rows = computeFeatures('AAA', series([10, 11, 12, 13]));
    expect(rows[1]!.ret_1d).toBeCloseTo(11 / 10 - 1, 9);
    expect(rows[0]!.ret_1d).toBeNull();
    expect(rows[0]!.ret_252d).toBeNull(); // not enough history
  });

  it('leaves long-window features null before warmup', () => {
    const rows = computeFeatures('AAA', series(closes));
    expect(rows[100]!.mom_12_1).toBeNull(); // needs 252 bars
    expect(rows[300]!.mom_12_1).not.toBeNull();
    expect(rows[300]!.ret_252d).not.toBeNull();
  });

  it('NO LOOKAHEAD: a feature row is invariant to changes in FUTURE bars', () => {
    const base = computeFeatures('AAA', series(closes));
    const i = 280;
    const row = base[i]!;

    // Poison every close AFTER index i.
    const mutated = [...closes];
    for (let k = i + 1; k < mutated.length; k++) mutated[k] = -999 + k;
    const rowMut = computeFeatures('AAA', series(mutated))[i]!;

    for (const key of ['ret_252d', 'mom_12_1', 'rsi_14', 'macd_hist', 'ema_gap', 'vol_21', 'dist_252high'] as const) {
      expect(rowMut[key]).toBeCloseTo(row[key] as number, 9);
    }
  });

  it('dist_252high is ≤ 0 and 0 at a new high', () => {
    const rising = series(Array.from({ length: 260 }, (_, i) => 100 + i)); // strictly rising
    const rows = computeFeatures('AAA', rising);
    expect(rows[259]!.dist_252high).toBeCloseTo(0, 9); // last bar is the high
  });
});

describe('buildTrainingExamples', () => {
  it('labels forward return and drops the unlabelable tail', () => {
    const bars = series(closes);
    const rows = computeFeatures('AAA', bars);
    const horizon = 21;
    const ex = buildTrainingExamples(bars, rows, horizon, new Date(2010, 6, 1));

    // No example can come from the last `horizon` bars.
    expect(ex.every((e) => e.ts <= bars[bars.length - 1 - horizon]!.timestamp)).toBe(true);
    // fwd_ret matches close[i+h]/close[i]-1 and label is its sign.
    const first = ex[0]!;
    const idx = bars.findIndex((b) => b.timestamp.getTime() === first.ts.getTime());
    expect(first.fwd_ret).toBeCloseTo(bars[idx + horizon]!.close / bars[idx]!.close - 1, 9);
    expect(first.label_up).toBe(first.fwd_ret > 0);
  });

  it('splits chronologically into train/test', () => {
    const bars = series(closes);
    const rows = computeFeatures('AAA', bars);
    const cut = new Date(2010, 9, 1);
    const ex = buildTrainingExamples(bars, rows, 21, cut);
    expect(ex.filter((e) => e.split === 'train').every((e) => e.ts < cut)).toBe(true);
    expect(ex.filter((e) => e.split === 'test').every((e) => e.ts >= cut)).toBe(true);
  });
});
