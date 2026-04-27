import {
  RSI,
  MACD,
  BollingerBands,
  EMA,
} from 'technicalindicators';

export interface IndicatorResult {
  rsi: number | null;
  macd: { value: number; signal: number; histogram: number } | null;
  bb: { upper: number; middle: number; lower: number } | null;
  ema20: number | null;
  ema50: number | null;
  signal: 'buy' | 'sell' | 'neutral';
  strength: number; // 0-1
}

export function calculateIndicators(closes: number[], period = 14): IndicatorResult {
  if (closes.length < 2) {
    return { rsi: null, macd: null, bb: null, ema20: null, ema50: null, signal: 'neutral', strength: 0 };
  }

  // RSI
  const rsiValues = RSI.calculate({ values: closes, period });
  const rsi = rsiValues.length > 0 ? (rsiValues[rsiValues.length - 1] ?? null) : null;

  // MACD (standard 12/26/9)
  const macdValues = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  let macd: IndicatorResult['macd'] = null;
  if (macdValues.length >= 2) {
    const last = macdValues[macdValues.length - 1]!;
    const prev = macdValues[macdValues.length - 2]!;
    if (
      last.MACD !== undefined && last.signal !== undefined && last.histogram !== undefined &&
      prev.MACD !== undefined && prev.signal !== undefined
    ) {
      macd = {
        value: last.MACD,
        signal: last.signal,
        histogram: last.histogram,
        // Store prev values for crossover detection via histogram sign change
      };
      // Attach previous histogram to detect crossover
      (macd as any)._prevHistogram = prev.histogram;
    }
  }

  // Bollinger Bands (period, stdDev=2)
  const bbValues = BollingerBands.calculate({ values: closes, period, stdDev: 2 });
  let bb: IndicatorResult['bb'] = null;
  if (bbValues.length > 0) {
    const last = bbValues[bbValues.length - 1]!;
    bb = { upper: last.upper, middle: last.middle, lower: last.lower };
  }

  // EMA 20 and 50
  const ema20Values = EMA.calculate({ values: closes, period: 20 });
  const ema20 = ema20Values.length > 0 ? (ema20Values[ema20Values.length - 1] ?? null) : null;

  const ema50Values = EMA.calculate({ values: closes, period: 50 });
  const ema50 = ema50Values.length > 0 ? (ema50Values[ema50Values.length - 1] ?? null) : null;

  // Composite signal
  const currentPrice = closes[closes.length - 1]!;
  const { signal, strength } = deriveSignal(rsi, macd, bb, currentPrice);

  return { rsi, macd, bb, ema20, ema50, signal, strength };
}

function deriveSignal(
  rsi: number | null,
  macd: IndicatorResult['macd'] | null,
  bb: IndicatorResult['bb'] | null,
  currentPrice: number
): { signal: 'buy' | 'sell' | 'neutral'; strength: number } {
  let buyScore = 0;
  let sellScore = 0;
  let factors = 0;

  // RSI signal
  if (rsi !== null) {
    factors++;
    if (rsi < 35) buyScore++;
    else if (rsi > 65) sellScore++;
  }

  // MACD crossover signal (histogram sign change)
  if (macd !== null) {
    factors++;
    const prevHistogram = (macd as any)._prevHistogram as number | undefined;
    const macdCrossPositive =
      prevHistogram !== undefined && prevHistogram < 0 && macd.histogram > 0;
    const macdCrossNegative =
      prevHistogram !== undefined && prevHistogram > 0 && macd.histogram < 0;

    if (macdCrossPositive || macd.histogram > 0) buyScore += 0.5;
    if (macdCrossNegative || macd.histogram < 0) sellScore += 0.5;
  }

  // Bollinger Bands signal — price near lower band = buy, near upper = sell
  if (bb !== null) {
    factors++;
    const bbRange = bb.upper - bb.lower;
    if (bbRange > 0) {
      const pctB = (currentPrice - bb.lower) / bbRange;
      if (pctB < 0.2) buyScore++;        // price near lower band
      else if (pctB > 0.8) sellScore++;  // price near upper band
    }
  }

  if (factors === 0) return { signal: 'neutral', strength: 0 };

  const maxPossible = factors;
  const buyStrength = buyScore / maxPossible;
  const sellStrength = sellScore / maxPossible;

  // Strong buy: RSI oversold + MACD turning positive + near lower BB
  if (buyScore >= 2 && buyStrength > 0.6) {
    return { signal: 'buy', strength: Math.min(1, buyStrength) };
  }
  // Strong sell: RSI overbought + MACD turning negative + near upper BB
  if (sellScore >= 2 && sellStrength > 0.6) {
    return { signal: 'sell', strength: Math.min(1, sellStrength) };
  }

  return { signal: 'neutral', strength: 0 };
}
