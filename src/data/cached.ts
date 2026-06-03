import { PriceBar } from '../shared/types';
import { logger } from '../shared/logger';
import { MarketDataProvider } from './index';
import { BarStore } from './types';

/**
 * CachedDataProvider composes a live MarketDataProvider with a local BarStore.
 *
 * getBars strategy:
 *   1. Ask the store first (fast, offline).
 *   2. If the store has enough bars (>= limit), return them directly (cache hit).
 *   3. Otherwise, fetch from the source, upsert into the store, and return the
 *      fresh bars (cache miss).
 *   4. If the source returns empty on a cache miss, return whatever the store had.
 *
 * getLatestPrice always delegates to the live source — real-time prices are not
 * worth caching.
 *
 * Never throws: all errors are logged and safe fallback values are returned.
 */
export class CachedDataProvider implements MarketDataProvider {
  constructor(
    private readonly source: MarketDataProvider,
    private readonly store: BarStore,
    private readonly sourceName: string = 'source',
  ) {}

  /**
   * Return up to `limit` bars for the given ticker/timeframe.
   * Reads from the local store first; falls back to the live source when needed.
   */
  async getBars(
    ticker: string,
    timeframe: string,
    limit: number,
  ): Promise<PriceBar[]> {
    // Step 1: check the local cache
    const cached = await this.store.getRecentBars(ticker, timeframe, limit);

    // Step 2: cache hit — store has at least as many bars as requested
    if (cached.length >= limit) {
      logger.debug('CachedDataProvider.getBars: cache hit', {
        ticker,
        timeframe,
        limit,
        cached: cached.length,
      });
      return cached;
    }

    // Step 3: cache miss — go to the live source
    logger.debug('CachedDataProvider.getBars: cache miss — fetching from source', {
      ticker,
      timeframe,
      limit,
      cached: cached.length,
      source: this.sourceName,
    });

    const fetched = await this.source.getBars(ticker, timeframe, limit);

    if (fetched.length > 0) {
      // Persist the freshly-fetched bars so subsequent calls are faster
      await this.store.upsertBars(timeframe, fetched, this.sourceName);
      return fetched;
    }

    // Step 4: source returned nothing — return whatever the store had (may be [])
    logger.debug(
      'CachedDataProvider.getBars: source returned empty, using cached fallback',
      { ticker, timeframe, limit, cached: cached.length },
    );
    return cached;
  }

  /**
   * Delegate to the live source — latest prices must not come from a cache.
   */
  async getLatestPrice(ticker: string): Promise<number | null> {
    return this.source.getLatestPrice(ticker);
  }
}
