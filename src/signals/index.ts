import { PriceBar, Signal } from '../shared/types';
import { calculateIndicators } from '../indicators';

/**
 * Produces a trading Signal for one instrument from its price history.
 * Technical-first (cost $0). A selective, cost-capped LLM gate is added later
 * by the signals/ agent (issue #4) — only the top 1–3 candidates per cycle.
 */
export interface SignalEngine {
  evaluate(ticker: string, bars: PriceBar[]): Promise<Signal>;
}

/**
 * Baseline technical engine mapping the existing indicators (RSI/MACD/BB) to a Signal.
 * The signals/ agent (issue #4) hardens this and adds the LLM gate.
 */
export class TechnicalSignalEngine implements SignalEngine {
  async evaluate(ticker: string, bars: PriceBar[]): Promise<Signal> {
    const closes = bars.map((b) => b.close);
    if (closes.length < 2) {
      return { ticker, action: 'hold', strength: 0, confidence: 0, reasons: ['insufficient data'], timestamp: new Date() };
    }

    const ind = calculateIndicators(closes);
    const reasons: string[] = [];
    if (ind.rsi !== null) reasons.push(`RSI=${ind.rsi.toFixed(1)}`);
    if (ind.macd) reasons.push(`MACD hist=${ind.macd.histogram.toFixed(3)}`);

    const action = ind.signal === 'neutral' ? 'hold' : ind.signal;
    return {
      ticker,
      action,
      strength: ind.strength,
      confidence: ind.strength, // refined by the LLM gate later
      reasons,
      timestamp: new Date(),
    };
  }
}
