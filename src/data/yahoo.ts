import axios from 'axios';
import { PriceBar } from '../shared/types';
import { MarketDataProvider } from './index';
import { logger } from '../shared/logger';

/**
 * Yahoo Finance market-data provider (free, no API key, ~20yr daily history).
 *
 * Uses the public chart endpoint. Returns split/dividend-ADJUSTED prices (OHLC
 * scaled by the adjclose/close ratio) so backtests are accurate across splits.
 * Never throws — logs and returns [] / null on failure.
 */
const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const TIMEOUT_MS = 15_000;

interface YahooChartResult {
  timestamp?: number[];
  indicators?: {
    quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }>;
    adjclose?: Array<{ adjclose?: (number | null)[] }>;
  };
}

function intervalFor(timeframe: string): string {
  if (/week/i.test(timeframe)) return '1wk';
  if (/month/i.test(timeframe)) return '1mo';
  return '1d';
}

function perBarMs(timeframe: string): number {
  if (/week/i.test(timeframe)) return 604_800_000;
  if (/month/i.test(timeframe)) return 2_592_000_000;
  return 86_400_000;
}

export class YahooDataProvider implements MarketDataProvider {
  async getBars(ticker: string, timeframe: string, limit: number): Promise<PriceBar[]> {
    const symbol = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
    if (!symbol || !Number.isInteger(limit) || limit < 1) {
      logger.warn('YahooDataProvider.getBars: invalid input', { ticker, limit });
      return [];
    }

    // Generous window (×2 for weekends/holidays); we slice to `limit` at the end.
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - Math.ceil((perBarMs(timeframe) * limit * 2) / 1000);
    const url = `${CHART_BASE}/${encodeURIComponent(symbol)}`;

    try {
      const resp = await axios.get(url, {
        params: { period1, period2, interval: intervalFor(timeframe), events: 'div,split' },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: TIMEOUT_MS,
      });
      const result: YahooChartResult | undefined = resp.data?.chart?.result?.[0];
      const bars = this.parse(symbol, result);
      return bars.length > limit ? bars.slice(bars.length - limit) : bars;
    } catch (err) {
      logger.warn('YahooDataProvider.getBars: request failed', {
        ticker: symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private parse(ticker: string, result?: YahooChartResult): PriceBar[] {
    const ts = result?.timestamp;
    const q = result?.indicators?.quote?.[0];
    const adj = result?.indicators?.adjclose?.[0]?.adjclose;
    if (!ts || !q || !q.close) return [];

    const out: PriceBar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close[i];
      const open = q.open?.[i];
      const high = q.high?.[i];
      const low = q.low?.[i];
      const volume = q.volume?.[i];
      // Skip incomplete rows (Yahoo pads with nulls on holidays/halts).
      if (close == null || open == null || high == null || low == null) continue;

      // Adjust OHLC by the adjclose/close ratio for split/dividend accuracy.
      const adjClose = adj?.[i];
      const factor = adjClose != null && close > 0 ? adjClose / close : 1;
      out.push({
        ticker,
        timestamp: new Date(ts[i]! * 1000),
        open: open * factor,
        high: high * factor,
        low: low * factor,
        close: close * factor,
        volume: volume ?? 0,
      });
    }
    return out;
  }

  async getLatestPrice(ticker: string): Promise<number | null> {
    const bars = await this.getBars(ticker, '1Day', 5);
    return bars.length > 0 ? bars[bars.length - 1]!.close : null;
  }
}
