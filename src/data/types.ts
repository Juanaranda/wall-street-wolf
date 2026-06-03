import { PriceBar } from '../shared/types';

/**
 * Local price-bar warehouse. Lets us cache deep history (e.g. 20+ years from
 * Stooq) in Postgres so backtests are fast, offline, reproducible, and don't
 * hammer external APIs. Bars are deduped by (ticker, timeframe, ts).
 */
export interface BarStore {
  /** Most recent `limit` bars for a ticker/timeframe, returned oldest → newest. */
  getRecentBars(ticker: string, timeframe: string, limit: number): Promise<PriceBar[]>;

  /**
   * Insert or update bars (idempotent dedup by ticker+timeframe+timestamp).
   * `source` records provenance (e.g. 'stooq', 'alpaca'). Returns rows upserted.
   */
  upsertBars(timeframe: string, bars: PriceBar[], source: string): Promise<number>;

  /** Number of stored bars for a ticker/timeframe (used to decide freshness). */
  count(ticker: string, timeframe: string): Promise<number>;
}
