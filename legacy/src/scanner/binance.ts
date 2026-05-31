import axios, { AxiosInstance } from 'axios';
import { Market } from '../shared/types';
import { logger } from '../shared/logger';
import { OrderBook } from './types';

const TOP_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT',
  'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'MATICUSDT',
];

const MIN_VOLUME_USDT = 1_000_000;

interface BinanceTicker24hr {
  symbol: string;
  lastPrice: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
  priceChangePercent: string;
}

export class BinanceClient {
  private readonly http: AxiosInstance;

  constructor(private readonly apiUrl: string) {
    this.http = axios.create({
      baseURL: apiUrl,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async fetchActiveMarkets(limit = 50): Promise<Market[]> {
    try {
      const response = await this.http.get<BinanceTicker24hr[]>('/v3/ticker/24hr');
      const tickers = response.data;

      const filtered = tickers.filter(
        (t) =>
          t.symbol.endsWith('USDT') &&
          TOP_SYMBOLS.includes(t.symbol) &&
          parseFloat(t.quoteVolume) > MIN_VOLUME_USDT
      );

      const sorted = filtered
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, limit);

      const now = new Date();
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      return sorted.map((t) => {
        const price = parseFloat(t.lastPrice);
        const high = parseFloat(t.highPrice);
        const low = parseFloat(t.lowPrice);
        const quoteVolume = parseFloat(t.quoteVolume);

        const range = high - low;
        const yesPrice =
          range > 0 ? Math.max(0.01, Math.min(0.99, (price - low) / range)) : 0.5;
        const noPrice = 1 - yesPrice;

        return {
          id: t.symbol,
          platform: 'binance' as const,
          question: `Will ${t.symbol} go up?`,
          description: `24h Binance spot market for ${t.symbol}`,
          yesPrice,
          noPrice,
          volume24h: quoteVolume,
          totalLiquidity: quoteVolume * 0.1,
          expiresAt: tomorrow,
          createdAt: now,
          category: 'crypto',
          tags: ['crypto', 'binance'],
        };
      });
    } catch (err: any) {
      logger.error(`BinanceClient.fetchActiveMarkets failed: ${err?.message ?? String(err)}`);
      return [];
    }
  }

  /** Returns close prices array for the given symbol and interval. */
  async fetchKlines(symbol: string, interval = '1h', limit = 100): Promise<number[]> {
    try {
      // Kline response: [openTime, open, high, low, close, volume, ...]
      const response = await this.http.get<Array<[number, string, string, string, string, ...unknown[]]>>(
        '/v3/klines',
        { params: { symbol, interval, limit } }
      );
      return response.data.map((candle) => parseFloat(candle[4]));
    } catch (err: any) {
      logger.warn(`BinanceClient.fetchKlines failed for ${symbol}: ${err?.message ?? String(err)}`);
      return [];
    }
  }

  async fetchOrderBook(symbol: string): Promise<OrderBook> {
    try {
      const response = await this.http.get<{
        bids: Array<[string, string]>;
        asks: Array<[string, string]>;
      }>('/v3/depth', { params: { symbol, limit: 20 } });

      return {
        marketId: symbol,
        bids: response.data.bids.map(([price, size]) => ({
          price: parseFloat(price),
          size: parseFloat(size),
        })),
        asks: response.data.asks.map(([price, size]) => ({
          price: parseFloat(price),
          size: parseFloat(size),
        })),
        timestamp: new Date(),
      };
    } catch (err: any) {
      logger.warn(`BinanceClient.fetchOrderBook failed for ${symbol}: ${err?.message ?? String(err)}`);
      return { marketId: symbol, bids: [], asks: [], timestamp: new Date() };
    }
  }
}
