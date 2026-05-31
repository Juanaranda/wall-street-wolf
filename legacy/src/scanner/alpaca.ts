import axios, { AxiosInstance } from 'axios';
import { Market } from '../shared/types';
import { logger } from '../shared/logger';
import { OrderBook } from './types';

const PAPER_BASE = 'https://paper-api.alpaca.markets';
const LIVE_BASE = 'https://api.alpaca.markets';
const DATA_BASE = 'https://data.alpaca.markets';

const TARGET_SYMBOLS = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA',
  'META', 'TSLA', 'JPM', 'V', 'UNH',
  'SPY', 'QQQ', 'IWM',
];

interface AlpacaAsset {
  id: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  asset_class: string;
}

interface AlpacaBar {
  t: string;  // timestamp
  o: number;  // open
  h: number;  // high
  l: number;  // low
  c: number;  // close
  v: number;  // volume
  vw: number; // vwap
}

interface AlpacaBarsResponse {
  bars: Record<string, AlpacaBar[]>;
  next_page_token?: string;
}

interface AlpacaLatestQuote {
  quote: {
    ap: number; // ask price
    bp: number; // bid price
    as: number; // ask size
    bs: number; // bid size
  };
}

/** Returns the next market close (4pm ET). */
function nextMarketClose(): Date {
  const now = new Date();
  // Market closes at 16:00 ET = 21:00 UTC
  const closeUtcHour = 21;
  const close = new Date(now);
  close.setUTCHours(closeUtcHour, 0, 0, 0);
  if (close <= now) {
    close.setUTCDate(close.getUTCDate() + 1);
  }
  return close;
}

export class AlpacaClient {
  private readonly http: AxiosInstance;
  private readonly dataHttp: AxiosInstance;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly paperTrading: boolean
  ) {
    const baseURL = paperTrading ? PAPER_BASE : LIVE_BASE;
    const authHeaders = {
      'APCA-API-KEY-ID': apiKey,
      'APCA-API-SECRET-KEY': apiSecret,
    };

    this.http = axios.create({
      baseURL,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json', ...authHeaders },
    });

    this.dataHttp = axios.create({
      baseURL: DATA_BASE,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json', ...authHeaders },
    });
  }

  async fetchActiveMarkets(limit = 30): Promise<Market[]> {
    try {
      const assetsResp = await this.http.get<AlpacaAsset[]>('/v2/assets', {
        params: { status: 'active', tradable: true, asset_class: 'us_equity' },
      });

      const targetSet = new Set(TARGET_SYMBOLS);
      const assets = assetsResp.data
        .filter((a) => targetSet.has(a.symbol))
        .slice(0, limit);

      if (assets.length === 0) return [];

      const symbols = assets.map((a) => a.symbol).join(',');
      const end = new Date();
      const start = new Date(end.getTime() - 2 * 24 * 60 * 60 * 1000); // last 2 days

      let barsMap: Record<string, AlpacaBar[]> = {};
      try {
        const barsResp = await this.dataHttp.get<AlpacaBarsResponse>('/v2/stocks/bars', {
          params: {
            symbols,
            timeframe: '1Day',
            start: start.toISOString(),
            end: end.toISOString(),
            limit: 2,
            feed: 'iex',
          },
        });
        barsMap = barsResp.data.bars ?? {};
      } catch (barsErr: any) {
        logger.warn(`AlpacaClient: failed to fetch bars: ${barsErr?.message ?? String(barsErr)}`);
      }

      const now = new Date();
      const marketClose = nextMarketClose();

      return assets.map((asset) => {
        const bars = barsMap[asset.symbol] ?? [];
        const latestBar = bars[bars.length - 1];
        const prevBar = bars.length >= 2 ? bars[bars.length - 2] : null;

        const close = latestBar?.c ?? 100;
        const high = latestBar?.h ?? close * 1.01;
        const low = latestBar?.l ?? close * 0.99;
        const prevClose = prevBar?.c ?? close;
        const volume = latestBar?.v ?? 0;

        const range = high - low;
        const yesPrice =
          range > 0 ? Math.max(0.01, Math.min(0.99, (close - low) / range)) : 0.5;
        const noPrice = 1 - yesPrice;

        // Liquidity estimate from daily volume × close price
        const totalLiquidity = volume * close * 0.001;

        return {
          id: asset.symbol,
          platform: 'alpaca' as const,
          question: `Will ${asset.symbol} close higher today?`,
          description: `${asset.name ?? asset.symbol} - US Equity`,
          yesPrice,
          noPrice,
          volume24h: volume,
          totalLiquidity,
          expiresAt: marketClose,
          createdAt: now,
          category: 'stocks',
          tags: ['stocks', 'alpaca', 'us_equity'],
        };
      });
    } catch (err: any) {
      logger.error(`AlpacaClient.fetchActiveMarkets failed: ${err?.message ?? String(err)}`);
      return [];
    }
  }

  async fetchOrderBook(symbol: string): Promise<OrderBook | null> {
    try {
      const response = await this.dataHttp.get<{ quote: AlpacaLatestQuote['quote'] }>(
        `/v2/stocks/${symbol}/quotes/latest`,
        { params: { feed: 'iex' } }
      );
      const q = response.data.quote;
      return {
        marketId: symbol,
        bids: [{ price: q.bp, size: q.bs }],
        asks: [{ price: q.ap, size: q.as }],
        timestamp: new Date(),
      };
    } catch (err: any) {
      logger.warn(`AlpacaClient.fetchOrderBook failed for ${symbol}: ${err?.message ?? String(err)}`);
      return null;
    }
  }
}
