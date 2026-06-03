import { RSI, MACD, EMA } from 'technicalindicators';
import { PriceBar } from '../shared/types';

/**
 * SILVER layer — point-in-time feature row for one bar.
 *
 * Every feature at bar `i` is computed using ONLY bars[0..i] (causal). This is
 * the same no-lookahead discipline as the backtester, enforced at the data level
 * so ML/analysis can't accidentally peek into the future.
 */
export interface FeatureRow {
  ticker: string;
  ts: Date;
  close: number;
  ret_1d: number | null;
  ret_21d: number | null;
  ret_63d: number | null;
  ret_126d: number | null;
  ret_252d: number | null;
  /** Canonical 12-1 momentum: return from t-252 to t-21 (skips the last month). */
  mom_12_1: number | null;
  rsi_14: number | null;
  macd_hist: number | null;
  /** (EMA20 − EMA50) / close — trend/regime signal. */
  ema_gap: number | null;
  /** Stdev of the last 21 daily returns (realized volatility). */
  vol_21: number | null;
  /** close / max(close over last 252 bars) − 1 — distance below the 52w high (≤ 0). */
  dist_252high: number | null;
}

const trailingReturn = (closes: number[], i: number, n: number): number | null =>
  i >= n && closes[i - n]! > 0 ? closes[i]! / closes[i - n]! - 1 : null;

/** Right-align an indicator series (length ≤ bars) to bar indices. */
function align(values: number[], total: number): (number | null)[] {
  const out: (number | null)[] = new Array(total).fill(null);
  const offset = total - values.length;
  for (let k = 0; k < values.length; k++) out[offset + k] = values[k]!;
  return out;
}

/**
 * Compute the full feature series for one instrument. Returns one FeatureRow per
 * bar (oldest→newest); features are null until enough history exists.
 */
export function computeFeatures(ticker: string, bars: PriceBar[]): FeatureRow[] {
  const closes = bars.map((b) => b.close);
  const n = closes.length;
  if (n === 0) return [];

  // Daily returns (index i = return from i-1 to i).
  const dailyRet: (number | null)[] = closes.map((c, i) =>
    i > 0 && closes[i - 1]! > 0 ? c / closes[i - 1]! - 1 : null
  );

  // Causal indicator series, right-aligned to bar indices.
  const rsi = align(RSI.calculate({ values: closes, period: 14 }), n);
  const macdRaw = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const macdHist = align(
    macdRaw.map((m) => (m.histogram ?? null)).filter((v): v is number => v !== null),
    n
  );
  const ema20 = align(EMA.calculate({ values: closes, period: 20 }), n);
  const ema50 = align(EMA.calculate({ values: closes, period: 50 }), n);

  const rows: FeatureRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      ticker,
      ts: bars[i]!.timestamp,
      close: closes[i]!,
      ret_1d: dailyRet[i] ?? null,
      ret_21d: trailingReturn(closes, i, 21),
      ret_63d: trailingReturn(closes, i, 63),
      ret_126d: trailingReturn(closes, i, 126),
      ret_252d: trailingReturn(closes, i, 252),
      mom_12_1:
        i >= 252 && closes[i - 252]! > 0 ? closes[i - 21]! / closes[i - 252]! - 1 : null,
      rsi_14: rsi[i] ?? null,
      macd_hist: macdHist[i] ?? null,
      ema_gap:
        ema20[i] != null && ema50[i] != null && closes[i]! > 0
          ? (ema20[i]! - ema50[i]!) / closes[i]!
          : null,
      vol_21: realizedVol(dailyRet, i, 21),
      dist_252high: distanceToHigh(closes, i, 252),
    });
  }
  return rows;
}

function realizedVol(dailyRet: (number | null)[], i: number, window: number): number | null {
  if (i < window) return null;
  const slice = dailyRet.slice(i - window + 1, i + 1).filter((v): v is number => v !== null);
  if (slice.length < window) return null;
  const mean = slice.reduce((s, r) => s + r, 0) / slice.length;
  const variance = slice.reduce((s, r) => s + (r - mean) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

function distanceToHigh(closes: number[], i: number, window: number): number | null {
  if (i < window - 1) return null;
  let max = -Infinity;
  for (let k = i - window + 1; k <= i; k++) if (closes[k]! > max) max = closes[k]!;
  return max > 0 ? closes[i]! / max - 1 : null;
}

/** GOLD layer — a feature row plus the supervised label (forward return). */
export interface TrainingExample extends FeatureRow {
  /** Forward return over `horizon` bars: close[i+h]/close[i] − 1 (the target). */
  fwd_ret: number;
  /** Binary label: did price rise over the horizon? */
  label_up: boolean;
  /** 'train' if ts < trainEnd, else 'test'. */
  split: 'train' | 'test';
}

/**
 * Build GOLD training examples: attach a forward-return label (uses FUTURE bars —
 * that's the target y, which is allowed) and a chronological train/test split.
 * Rows without `horizon` future bars, or with any required feature null, are dropped.
 */
export function buildTrainingExamples(
  bars: PriceBar[],
  rows: FeatureRow[],
  horizon: number,
  trainEnd: Date
): TrainingExample[] {
  const closes = bars.map((b) => b.close);
  const examples: TrainingExample[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (i + horizon >= closes.length) break; // no future bar to label
    const row = rows[i]!;
    // Require the core momentum features to be present.
    if (row.mom_12_1 === null || row.rsi_14 === null || row.vol_21 === null) continue;
    const entry = closes[i]!;
    if (entry <= 0) continue;
    const fwd = closes[i + horizon]! / entry - 1;
    examples.push({
      ...row,
      fwd_ret: fwd,
      label_up: fwd > 0,
      split: row.ts < trainEnd ? 'train' : 'test',
    });
  }
  return examples;
}
