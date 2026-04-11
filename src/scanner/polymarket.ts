import axios, { AxiosInstance } from 'axios';
import { Market } from '../shared/types';
import { logger } from '../shared/logger';
import { PolymarketApiMarket, OrderBook, OrderBookLevel } from './types';

const DEFAULT_BASE_URL = 'https://clob.polymarket.com';

export class PolymarketClient {
  private readonly http: AxiosInstance;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async fetchActiveMarkets(limit: number = 100): Promise<Market[]> {
    const markets: Market[] = [];
    let cursor: string | undefined;

    try {
      do {
        const params: Record<string, unknown> = {
          active: true,
          closed: false,
          limit: Math.min(limit - markets.length, 100),
        };
        if (cursor) params['next_cursor'] = cursor;

        const response = await this.http.get<{
          data: PolymarketApiMarket[];
          next_cursor?: string;
        }>('/markets', { params });

        const page = (response.data.data ?? [])
          .filter((m) => m.active && !m.closed)
          .map((m) => this.normalize(m));

        markets.push(...page);
        cursor = response.data.next_cursor;
      } while (cursor && markets.length < limit);

      return markets;
    } catch (err) {
      logger.error('PolymarketClient.fetchActiveMarkets failed', { err });
      return markets; // return whatever was fetched before the error
    }
  }

  async fetchOrderBook(conditionId: string): Promise<OrderBook | null> {
    try {
      const response = await this.http.get<{
        bids: Array<{ price: string; size: string }>;
        asks: Array<{ price: string; size: string }>;
      }>(`/book`, { params: { token_id: conditionId } });

      const toLevel = (l: { price: string; size: string }): OrderBookLevel => ({
        price: parseFloat(l.price),
        size: parseFloat(l.size),
      });

      return {
        marketId: conditionId,
        bids: response.data.bids.map(toLevel),
        asks: response.data.asks.map(toLevel),
        timestamp: new Date(),
      };
    } catch (err: any) {
      logger.warn(`PolymarketClient.fetchOrderBook failed: ${err?.message ?? String(err)} (status: ${err?.response?.status ?? 'n/a'})`, { conditionId });
      return null;
    }
  }

  async fetchMarketHistory(
    conditionId: string,
    days: number = 7
  ): Promise<Array<{ timestamp: Date; price: number; volume: number }>> {
    try {
      const startTs = Math.floor(
        (Date.now() - days * 24 * 60 * 60 * 1000) / 1000
      );
      const response = await this.http.get<
        Array<{ t: number; p: number; v: number }>
      >(`/prices-history`, {
        params: { market: conditionId, startTs, fidelity: 60 },
      });
      return response.data.map((d) => ({
        timestamp: new Date(d.t * 1000),
        price: d.p,
        volume: d.v,
      }));
    } catch (err: any) {
      logger.warn(`PolymarketClient.fetchMarketHistory failed: ${err?.message ?? String(err)} (status: ${err?.response?.status ?? 'n/a'})`, { conditionId });
      return [];
    }
  }

  private normalize(raw: PolymarketApiMarket): Market {
    const yesToken = raw.tokens.find((t) => t.outcome.toLowerCase() === 'yes');
    const noToken = raw.tokens.find((t) => t.outcome.toLowerCase() === 'no');
    return {
      id: raw.condition_id,
      platform: 'polymarket',
      question: raw.question,
      description: raw.description ?? '',
      yesPrice: yesToken?.price ?? 0.5,
      noPrice: noToken?.price ?? 0.5,
      volume24h: raw.volume ?? 0,
      totalLiquidity: raw.liquidity ?? 0,
      expiresAt: new Date(raw.end_date_iso),
      createdAt: new Date(),
      category: raw.category ?? 'general',
      tags: raw.tags ?? [],
    };
  }
}
