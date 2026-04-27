import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { createPrivateKey, sign as cryptoSign, constants as cryptoConstants } from 'crypto';
import { Market } from '../shared/types';
import { logger } from '../shared/logger';
import { KalshiApiMarket, OrderBook } from './types';

const DEMO_BASE_URL = 'https://demo-api.kalshi.co/trade-api/v2';

export class KalshiClient {
  private readonly http: AxiosInstance;

  constructor(
    private readonly baseUrl: string = DEMO_BASE_URL,
    private readonly apiKeyId: string = '',
    private readonly privateKey: string = ''
  ) {
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Attach RSA signing interceptor to every request
    this.http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
      if (!this.apiKeyId || !this.privateKey) return config;

      const timestampMs = Date.now().toString();
      const method = (config.method ?? 'GET').toUpperCase();
      // Build full path: baseUrl contributes its pathname prefix (e.g. /trade-api/v2)
      // new URL(relPath, base) with an absolute relPath ignores base's pathname, so we build manually
      const basePath = new URL(this.baseUrl).pathname.replace(/\/$/, '');
      const reqParsed = new URL(config.url ?? '', 'http://localhost');
      const pathAndQuery = basePath + reqParsed.pathname + reqParsed.search;
      // Kalshi signs: timestamp + method + path (body NOT included)
      const msgToSign = timestampMs + method + pathAndQuery;

      const keyObj = createPrivateKey(this.privateKey);
      const signature = cryptoSign(
        'sha256',
        Buffer.from(msgToSign),
        { key: keyObj, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST }
      ).toString('base64');

      config.headers['KALSHI-Access-Key'] = this.apiKeyId;
      config.headers['KALSHI-Access-Signature'] = signature;
      config.headers['KALSHI-Access-Timestamp'] = timestampMs;

      return config;
    });
  }

  /** RSA key auth — validates key presence, no login call needed. */
  async authenticate(): Promise<void> {
    if (!this.apiKeyId || !this.privateKey) {
      throw new Error('KalshiClient: KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY are required');
    }
    logger.info('KalshiClient: using RSA key authentication');
  }

  async fetchActiveMarkets(limit: number = 100): Promise<Market[]> {
    try {
      const response = await this.http.get<{ markets: KalshiApiMarket[] }>(
        '/markets',
        { params: { limit, status: 'open' } }
      );
      return response.data.markets.map((m) => this.normalize(m));
    } catch (err: any) {
      logger.error(`KalshiClient.fetchActiveMarkets failed: ${err?.message ?? String(err)} (status: ${err?.response?.status ?? 'n/a'})`);
      return [];
    }
  }

  async fetchOrderBook(ticker: string): Promise<OrderBook | null> {
    try {
      const response = await this.http.get<{
        orderbook?: {
          yes?: Array<[number, number]>;
          no?: Array<[number, number]>;
        };
      }>(`/markets/${ticker}/orderbook`);

      const ob = response.data?.orderbook;
      if (!ob) {
        // Market exists but has no order book yet — return empty book
        return { marketId: ticker, bids: [], asks: [], timestamp: new Date() };
      }

      return {
        marketId: ticker,
        bids: (ob.yes ?? []).map(([price, size]) => ({ price: price / 100, size })),
        asks: (ob.no ?? []).map(([price, size]) => ({ price: 1 - price / 100, size })),
        timestamp: new Date(),
      };
    } catch (err: any) {
      logger.warn(`KalshiClient.fetchOrderBook failed: ${err?.message ?? String(err)} (status: ${err?.response?.status ?? 'n/a'})`, { ticker });
      return null;
    }
  }

  private normalize(raw: KalshiApiMarket): Market {
    // Kalshi prices are in cents (0-99); divide by 100. Default to 0.5 if missing.
    const yesMid = raw.yes_bid != null && raw.yes_ask != null
      ? (raw.yes_bid + raw.yes_ask) / 2 / 100
      : 0.5;
    const noMid = raw.no_bid != null && raw.no_ask != null
      ? (raw.no_bid + raw.no_ask) / 2 / 100
      : 1 - yesMid;
    return {
      id: raw.ticker,
      platform: 'kalshi',
      question: raw.title,
      description: '',
      yesPrice: Math.max(0.01, Math.min(0.99, yesMid)),
      noPrice: Math.max(0.01, Math.min(0.99, noMid)),
      volume24h: raw.volume ?? 0,
      totalLiquidity: raw.open_interest ?? 0,
      expiresAt: new Date(raw.close_time),
      createdAt: new Date(),
      category: raw.category ?? 'general',
      tags: [],
    };
  }
}
