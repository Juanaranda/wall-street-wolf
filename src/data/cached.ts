import { PriceBar } from '../shared/types';
import { logger } from '../shared/logger';
import { MarketDataProvider } from './index';
import { BarStore } from './types';

/** Default freshness window: refresh if the newest cached bar is older than this. */
const DEFAULT_MAX_STALE_MS = 20 * 60 * 60 * 1000; // 20 hours → picks up each daily close

/**
 * CachedDataProvider composes a live MarketDataProvider with a local BarStore.
 *
 * getBars strategy (self-maintaining):
 *   1. Ask the store first (fast, offline).
 *   2. Cache hit only if it has enough bars (>= limit) AND the newest bar is
 *      FRESH (within maxStaleMs). Otherwise refresh from the source and upsert.
 *   3. If the source returns empty, fall back to whatever the store had (stale
 *      data beats no data).
 *
 * This means just running `signal` keeps the warehouse up to date automatically.
 *
 * getLatestPrice always delegates to the live source.
 * Never throws: all errors are logged and safe fallback values are returned.
 */
export class CachedDataProvider implements MarketDataProvider {
  constructor(
    private readonly source: MarketDataProvider,
    private readonly store: BarStore,
    private readonly sourceName: string = 'source',
    private readonly maxStaleMs: number = DEFAULT_MAX_STALE_MS,
  ) {}

  /** True if the newest bar is recent enough to skip a refresh. */
  private isFresh(bars: PriceBar[]): boolean {
    const last = bars[bars.length - 1];
    if (!last) return false;
    return Date.now() - last.timestamp.getTime() <= this.maxStaleMs;
  }

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

    // Step 2: cache hit — enough bars AND fresh
    if (cached.length >= limit && this.isFresh(cached)) {
      logger.debug('CachedDataProvider.getBars: cache hit (fresh)', {
        ticker,
        timeframe,
        limit,
        cached: cached.length,
      });
      return cached;
    }

    // Step 3: stale or insufficient — refresh from the live source
    logger.debug('CachedDataProvider.getBars: refreshing from source', {
      ticker,
      timeframe,
      limit,
      cached: cached.length,
      stale: cached.length >= limit,
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
