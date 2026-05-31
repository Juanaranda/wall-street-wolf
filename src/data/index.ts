import axios, { AxiosInstance } from 'axios';
import { PriceBar } from '../shared/types';
import { logger } from '../shared/logger';

/**
 * Read-only market data. NO order execution — the user trades manually in Fintual.
 * Implementations fetch OHLCV bars and latest prices for US instruments.
 */
export interface MarketDataProvider {
  /** Historical OHLCV bars, oldest→newest. `timeframe` e.g. '1Day', '1Hour'. */
  getBars(ticker: string, timeframe: string, limit: number): Promise<PriceBar[]>;
  /** Most recent trade/quote price, or null if unavailable. */
  getLatestPrice(ticker: string): Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Internal types for Alpaca API responses
// ---------------------------------------------------------------------------

interface AlpacaBar {
  t: string; // RFC3339 timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
}

interface AlpacaBarsResponse {
  bars: AlpacaBar[];
  next_page_token?: string | null;
}

interface AlpacaLatestTradeResponse {
  trade: {
    p: number; // price
    t: string; // timestamp
  };
}

interface AlpacaLatestQuoteResponse {
  quote: {
    ap: number; // ask price
    bp: number; // bid price
    t: string;  // timestamp
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_BASE_URL = 'https://data.alpaca.markets';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateTicker(ticker: string): boolean {
  return typeof ticker === 'string' && /^[A-Z]{1,10}$/.test(ticker.trim());
}

function validateTimeframe(timeframe: string): boolean {
  return typeof timeframe === 'string' && timeframe.trim().length > 0;
}

function validateLimit(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= 10_000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapBar(ticker: string, bar: AlpacaBar): PriceBar {
  return {
    ticker,
    timestamp: new Date(bar.t),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  };
}

// ---------------------------------------------------------------------------
// AlpacaDataProvider
// ---------------------------------------------------------------------------

/**
 * Market-data provider backed by Alpaca's free Data API v2.
 * Only reads prices — no order execution at all.
 *
 * Environment variables expected:
 *   ALPACA_API_KEY      – Alpaca key ID
 *   ALPACA_API_SECRET   – Alpaca key secret
 *
 * If keys are absent or any request fails, the method logs a warning and
 * returns [] / null (never throws). The pipeline stays operational even
 * without credentials (stub behaviour for local dev / CI without secrets).
 */
export class AlpacaDataProvider implements MarketDataProvider {
  private readonly client: AxiosInstance;
  private readonly hasCredentials: boolean;

  constructor(
    private readonly apiKey: string = '',
    private readonly apiSecret: string = ''
  ) {
    this.hasCredentials = apiKey.trim().length > 0 && apiSecret.trim().length > 0;

    this.client = axios.create({
      baseURL: DATA_BASE_URL,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': apiSecret,
      },
    });
  }

  /**
   * Fetch historical OHLCV bars for a single ticker.
   * Returns bars ordered oldest → newest.
   *
   * @param ticker    - Ticker symbol (case-insensitive), e.g. 'AAPL' or 'aapl'
   * @param timeframe - Alpaca timeframe string, e.g. '1Day', '1Hour', '15Min'
   * @param limit     - Number of bars to return (1–10 000)
   */
  async getBars(ticker: string, timeframe: string, limit: number): Promise<PriceBar[]> {
    if (!this.hasCredentials) {
      logger.warn('AlpacaDataProvider.getBars: no API credentials — returning empty bars', { ticker });
      return [];
    }

    // Normalise before validating so callers may pass lowercase tickers
    const symbol = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';

    if (!validateTicker(symbol)) {
      logger.warn('AlpacaDataProvider.getBars: invalid ticker', { ticker });
      return [];
    }

    if (!validateTimeframe(timeframe)) {
      logger.warn('AlpacaDataProvider.getBars: invalid timeframe', { timeframe });
      return [];
    }

    if (!validateLimit(limit)) {
      logger.warn('AlpacaDataProvider.getBars: invalid limit', { limit });
      return [];
    }
    const url = `/v2/stocks/${symbol}/bars`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.get<AlpacaBarsResponse>(url, {
          params: {
            timeframe,
            limit,
            sort: 'asc',
          },
        });

        const rawBars: AlpacaBar[] = response.data?.bars ?? [];
        return rawBars.map((b) => mapBar(symbol, b));
      } catch (err: unknown) {
        const isLastAttempt = attempt === MAX_RETRIES;
        if (isLastAttempt) {
          logger.warn('AlpacaDataProvider.getBars: request failed after retries', {
            ticker: symbol,
            timeframe,
            limit,
            error: extractErrorMessage(err),
          });
          return [];
        }
        logger.warn('AlpacaDataProvider.getBars: transient error, retrying', {
          attempt: attempt + 1,
          ticker: symbol,
          error: extractErrorMessage(err),
        });
        await sleep(RETRY_DELAY_MS);
      }
    }

    // Unreachable, but satisfies TypeScript's return-type check
    return [];
  }

  /**
   * Fetch the latest trade price for a single ticker.
   * Falls back to the midpoint of the latest quote if the trades endpoint
   * returns no data.
   *
   * @param ticker - Uppercase ticker symbol, e.g. 'AAPL'
   * @returns Latest price, or null if unavailable
   */
  async getLatestPrice(ticker: string): Promise<number | null> {
    if (!this.hasCredentials) {
      logger.warn('AlpacaDataProvider.getLatestPrice: no API credentials', { ticker });
      return null;
    }

    // Normalise before validating so callers may pass lowercase tickers
    const symbol = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';

    if (!validateTicker(symbol)) {
      logger.warn('AlpacaDataProvider.getLatestPrice: invalid ticker', { ticker });
      return null;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Primary: latest trade
        const tradeUrl = `/v2/stocks/${symbol}/trades/latest`;
        const tradeResp = await this.client.get<AlpacaLatestTradeResponse>(tradeUrl);
        const price = tradeResp.data?.trade?.p;
        if (typeof price === 'number' && Number.isFinite(price)) {
          return price;
        }

        // Fallback: latest quote midpoint
        const quoteUrl = `/v2/stocks/${symbol}/quotes/latest`;
        const quoteResp = await this.client.get<AlpacaLatestQuoteResponse>(quoteUrl);
        const ask = quoteResp.data?.quote?.ap;
        const bid = quoteResp.data?.quote?.bp;
        if (typeof ask === 'number' && typeof bid === 'number' && ask > 0 && bid > 0) {
          return (ask + bid) / 2;
        }

        logger.warn('AlpacaDataProvider.getLatestPrice: no valid price in response', { ticker: symbol });
        return null;
      } catch (err: unknown) {
        const isLastAttempt = attempt === MAX_RETRIES;
        if (isLastAttempt) {
          logger.warn('AlpacaDataProvider.getLatestPrice: request failed after retries', {
            ticker: symbol,
            error: extractErrorMessage(err),
          });
          return null;
        }
        logger.warn('AlpacaDataProvider.getLatestPrice: transient error, retrying', {
          attempt: attempt + 1,
          ticker: symbol,
          error: extractErrorMessage(err),
        });
        await sleep(RETRY_DELAY_MS);
      }
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function extractErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = JSON.stringify(err.response?.data ?? {});
    return `AxiosError status=${status ?? 'network'} data=${data}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
