import { Pool, PoolClient } from 'pg';
import { PriceBar } from '../shared/types';
import { BarStore } from './types';
import { logger } from '../shared/logger';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ENSURE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS price_bars (
    ticker      TEXT              NOT NULL,
    timeframe   TEXT              NOT NULL,
    ts          TIMESTAMPTZ       NOT NULL,
    open        DOUBLE PRECISION,
    high        DOUBLE PRECISION,
    low         DOUBLE PRECISION,
    close       DOUBLE PRECISION,
    volume      DOUBLE PRECISION,
    source      TEXT,
    PRIMARY KEY (ticker, timeframe, ts)
  );
`;

// ---------------------------------------------------------------------------
// Pool-like interface — allows injecting a test double
// ---------------------------------------------------------------------------

/** Minimal subset of `pg.Pool` that PostgresBarStore depends on. */
export interface QueryRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Maximum number of bars to insert in a single multi-row INSERT statement. */
const CHUNK_SIZE = 500;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Build a parameterised multi-row INSERT … ON CONFLICT DO UPDATE statement. */
function buildUpsertSql(
  bars: PriceBar[],
  timeframe: string,
  source: string
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const valueClauses: string[] = [];

  bars.forEach((bar, idx) => {
    const base = idx * 9; // 9 columns per row; first row uses $1..$9
    valueClauses.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`
    );
    params.push(
      bar.ticker,
      timeframe,
      bar.timestamp,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.volume,
      source
    );
  });

  const sql = `
    INSERT INTO price_bars (ticker, timeframe, ts, open, high, low, close, volume, source)
    VALUES ${valueClauses.join(', ')}
    ON CONFLICT (ticker, timeframe, ts) DO UPDATE
      SET open   = EXCLUDED.open,
          high   = EXCLUDED.high,
          low    = EXCLUDED.low,
          close  = EXCLUDED.close,
          volume = EXCLUDED.volume,
          source = EXCLUDED.source
  `;

  return { sql, params };
}

// ---------------------------------------------------------------------------
// PostgresBarStore
// ---------------------------------------------------------------------------

/**
 * Postgres-backed local price-bar warehouse.
 *
 * Deduplication is handled at the DB level: the primary key
 * `(ticker, timeframe, ts)` plus `ON CONFLICT … DO UPDATE` makes every
 * upsert idempotent, so replaying the same feed never produces duplicates.
 *
 * Usage with a real database:
 *   const store = new PostgresBarStore();               // reads DATABASE_URL
 *   const store = new PostgresBarStore(connectionString);
 *
 * Usage in tests (inject a mock):
 *   const store = new PostgresBarStore(undefined, mockPool);
 */
export class PostgresBarStore implements BarStore {
  private readonly pool: QueryRunner;
  private schemaEnsured = false;

  constructor(
    connectionString?: string,
    poolOverride?: QueryRunner
  ) {
    if (poolOverride !== undefined) {
      this.pool = poolOverride;
    } else {
      const connStr = connectionString ?? process.env['DATABASE_URL'];
      this.pool = new Pool(connStr ? { connectionString: connStr } : undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Schema bootstrap (lazy, once per instance)
  // -------------------------------------------------------------------------

  private async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;
    await this.pool.query(ENSURE_TABLE_SQL);
    this.schemaEnsured = true;
  }

  // -------------------------------------------------------------------------
  // BarStore interface
  // -------------------------------------------------------------------------

  /**
   * Insert or update bars.  Idempotent — re-inserting the same bar updates
   * its OHLCV values and records the latest `source`.
   *
   * @returns Number of bars written (0 on error).
   */
  async upsertBars(timeframe: string, bars: PriceBar[], source: string): Promise<number> {
    if (bars.length === 0) return 0;

    try {
      await this.ensureSchema();

      let total = 0;
      const chunks = chunkArray(bars, CHUNK_SIZE);

      for (const chunk of chunks) {
        const { sql, params } = buildUpsertSql(chunk, timeframe, source);
        const result = await this.pool.query(sql, params);
        total += result.rowCount ?? chunk.length;
      }

      return total;
    } catch (err: unknown) {
      logger.error('PostgresBarStore.upsertBars failed', {
        timeframe,
        barCount: bars.length,
        source,
        error: extractMessage(err),
      });
      return 0;
    }
  }

  /**
   * Fetch the most recent `limit` bars for a ticker/timeframe, ordered
   * oldest → newest (suitable for indicator calculations).
   */
  async getRecentBars(ticker: string, timeframe: string, limit: number): Promise<PriceBar[]> {
    try {
      await this.ensureSchema();

      const sql = `
        SELECT ticker, ts, open, high, low, close, volume
        FROM price_bars
        WHERE ticker = $1 AND timeframe = $2
        ORDER BY ts DESC
        LIMIT $3
      `;
      const result = await this.pool.query(sql, [ticker, timeframe, limit]);

      // DESC query → reverse to oldest→newest before returning
      return (result.rows as DbRow[]).reverse().map(mapRow);
    } catch (err: unknown) {
      logger.error('PostgresBarStore.getRecentBars failed', {
        ticker,
        timeframe,
        limit,
        error: extractMessage(err),
      });
      return [];
    }
  }

  /**
   * Count the number of stored bars for a ticker/timeframe.
   * Used by callers to decide whether the local cache is fresh enough.
   */
  async count(ticker: string, timeframe: string): Promise<number> {
    try {
      await this.ensureSchema();

      const sql = `
        SELECT COUNT(*) AS n
        FROM price_bars
        WHERE ticker = $1 AND timeframe = $2
      `;
      const result = await this.pool.query(sql, [ticker, timeframe]);
      const row = (result.rows as Array<{ n: string | number }>)[0];
      return row ? Number(row['n']) : 0;
    } catch (err: unknown) {
      logger.error('PostgresBarStore.count failed', {
        ticker,
        timeframe,
        error: extractMessage(err),
      });
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface DbRow {
  ticker: string;
  ts: Date | string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
}

function mapRow(row: DbRow): PriceBar {
  return {
    ticker: row.ticker,
    timestamp: row.ts instanceof Date ? row.ts : new Date(row.ts),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  };
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
