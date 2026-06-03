/**
 * Tests for PostgresBarStore (src/data/bar-store.ts).
 * All DB calls are mocked — no real Postgres connection is used.
 */

import { PostgresBarStore, QueryRunner } from '../src/data/bar-store';
import { PriceBar } from '../src/shared/types';

// ---------------------------------------------------------------------------
// Mock logger so console stays clean and we can assert on logged errors
// ---------------------------------------------------------------------------

jest.mock('../src/shared/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

import { logger } from '../src/shared/logger';
const mockLogger = logger as jest.Mocked<typeof logger>;

// ---------------------------------------------------------------------------
// Fake Pool builder
// ---------------------------------------------------------------------------

function makePool(
  queryImpl?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>
): QueryRunner & { query: jest.Mock } {
  const mock = jest.fn(
    queryImpl ??
      (() => Promise.resolve({ rows: [], rowCount: 0 }))
  );
  return { query: mock };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T1 = new Date('2024-01-01T00:00:00Z');
const T2 = new Date('2024-01-02T00:00:00Z');
const T3 = new Date('2024-01-03T00:00:00Z');

const BAR1: PriceBar = { ticker: 'AAPL', timestamp: T1, open: 100, high: 105, low: 99, close: 103, volume: 1_000_000 };
const BAR2: PriceBar = { ticker: 'AAPL', timestamp: T2, open: 103, high: 107, low: 102, close: 106, volume: 1_200_000 };
const BAR3: PriceBar = { ticker: 'AAPL', timestamp: T3, open: 106, high: 110, low: 105, close: 109, volume: 900_000 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check that sql contains all expected substrings (case-insensitive). */
function sqlContains(sql: string, ...fragments: string[]): boolean {
  const lower = sql.toLowerCase();
  return fragments.every((f) => lower.includes(f.toLowerCase()));
}

// ---------------------------------------------------------------------------
// ensureSchema
// ---------------------------------------------------------------------------

describe('PostgresBarStore — schema bootstrap', () => {
  it('calls CREATE TABLE IF NOT EXISTS on first operation', async () => {
    const pool = makePool();
    const store = new PostgresBarStore(undefined, pool);

    await store.count('AAPL', '1Day');

    // First call must be the schema DDL
    const [firstSql] = pool.query.mock.calls[0] as [string];
    expect(sqlContains(firstSql, 'CREATE TABLE IF NOT EXISTS', 'price_bars')).toBe(true);
  });

  it('calls CREATE TABLE only once across multiple operations', async () => {
    const pool = makePool(() =>
      Promise.resolve({ rows: [{ n: '5' }], rowCount: 1 })
    );
    const store = new PostgresBarStore(undefined, pool);

    await store.count('AAPL', '1Day');
    await store.count('MSFT', '1Hour');
    await store.count('SPY', '1Day');

    const ddlCalls = pool.query.mock.calls.filter(([sql]: [string]) =>
      sqlContains(sql, 'CREATE TABLE IF NOT EXISTS')
    );
    expect(ddlCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// upsertBars — SQL structure and params
// ---------------------------------------------------------------------------

describe('PostgresBarStore.upsertBars', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 0 immediately for an empty bar array (no DB call)', async () => {
    const pool = makePool();
    const store = new PostgresBarStore(undefined, pool);

    const count = await store.upsertBars('1Day', [], 'stooq');

    expect(count).toBe(0);
    // ensureSchema is skipped too because bars.length === 0 short-circuits
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('uses INSERT … ON CONFLICT … DO UPDATE for idempotent dedup', async () => {
    const pool = makePool(() => Promise.resolve({ rows: [], rowCount: 2 }));
    const store = new PostgresBarStore(undefined, pool);

    await store.upsertBars('1Day', [BAR1, BAR2], 'alpaca');

    const insertCall = pool.query.mock.calls.find(([sql]: [string]) =>
      sqlContains(sql, 'INSERT INTO price_bars')
    );
    expect(insertCall).toBeDefined();
    const [insertSql] = insertCall as [string];
    expect(sqlContains(insertSql, 'ON CONFLICT', 'DO UPDATE')).toBe(true);
  });

  it('passes ticker, timeframe, timestamp, OHLCV and source as params', async () => {
    const pool = makePool(() => Promise.resolve({ rows: [], rowCount: 1 }));
    const store = new PostgresBarStore(undefined, pool);

    await store.upsertBars('1Day', [BAR1], 'stooq');

    const insertCall = pool.query.mock.calls.find(([sql]: [string]) =>
      sqlContains(sql, 'INSERT INTO price_bars')
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];

    expect(params).toContain('AAPL');        // ticker
    expect(params).toContain('1Day');        // timeframe
    expect(params).toContain(T1);            // timestamp
    expect(params).toContain(100);           // open
    expect(params).toContain(105);           // high
    expect(params).toContain(99);            // low
    expect(params).toContain(103);           // close
    expect(params).toContain(1_000_000);     // volume
    expect(params).toContain('stooq');       // source
  });

  it('returns the rowCount reported by the pool', async () => {
    const pool = makePool(() => Promise.resolve({ rows: [], rowCount: 3 }));
    const store = new PostgresBarStore(undefined, pool);

    const result = await store.upsertBars('1Day', [BAR1, BAR2, BAR3], 'stooq');

    expect(result).toBe(3);
  });

  it('batches large inserts into CHUNK_SIZE groups (500 bars)', async () => {
    const pool = makePool(() => Promise.resolve({ rows: [], rowCount: 500 }));
    const store = new PostgresBarStore(undefined, pool);

    // Build 1100 bars (should produce 3 chunks: 500 + 500 + 100)
    const bars: PriceBar[] = Array.from({ length: 1100 }, (_, i) => ({
      ticker: 'SPY',
      timestamp: new Date(T1.getTime() + i * 86_400_000),
      open: 400 + i,
      high: 401 + i,
      low: 399 + i,
      close: 400.5 + i,
      volume: 50_000_000,
    }));

    await store.upsertBars('1Day', bars, 'stooq');

    const insertCalls = pool.query.mock.calls.filter(([sql]: [string]) =>
      sqlContains(sql, 'INSERT INTO price_bars')
    );
    expect(insertCalls).toHaveLength(3);
  });

  it('includes correct number of value placeholders per bar (9 columns)', async () => {
    const pool = makePool(() => Promise.resolve({ rows: [], rowCount: 1 }));
    const store = new PostgresBarStore(undefined, pool);

    await store.upsertBars('1Day', [BAR1], 'stooq');

    const insertCall = pool.query.mock.calls.find(([sql]: [string]) =>
      sqlContains(sql, 'INSERT INTO price_bars')
    );
    const [insertSql] = insertCall as [string];
    // 9 columns → params $1..$9
    expect(insertSql).toContain('$9');
    expect(insertSql).not.toContain('$10');
  });

  it('handles null rowCount gracefully (falls back to chunk.length)', async () => {
    const pool = makePool(() => Promise.resolve({ rows: [], rowCount: null }));
    const store = new PostgresBarStore(undefined, pool);

    const result = await store.upsertBars('1Day', [BAR1, BAR2], 'alpaca');

    // rowCount is null → falls back to chunk.length (2)
    expect(result).toBe(2);
  });

  it('returns 0 and logs error on DB failure — never throws', async () => {
    const pool = makePool(() => Promise.reject(new Error('connection refused')));
    const store = new PostgresBarStore(undefined, pool);

    const result = await store.upsertBars('1Day', [BAR1], 'stooq');

    expect(result).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'PostgresBarStore.upsertBars failed',
      expect.objectContaining({ error: 'connection refused' })
    );
  });
});

// ---------------------------------------------------------------------------
// getRecentBars — mapping and result ordering
// ---------------------------------------------------------------------------

describe('PostgresBarStore.getRecentBars', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries with correct ticker, timeframe, limit params', async () => {
    const pool = makePool(() => Promise.resolve({ rows: [], rowCount: 0 }));
    const store = new PostgresBarStore(undefined, pool);

    await store.getRecentBars('MSFT', '1Hour', 20);

    const selectCall = pool.query.mock.calls.find(([sql]: [string]) =>
      sqlContains(sql, 'SELECT', 'price_bars')
    );
    expect(selectCall).toBeDefined();
    const params = selectCall![1] as unknown[];
    expect(params).toEqual(['MSFT', '1Hour', 20]);
  });

  it('uses DESC ordering in the SELECT query', async () => {
    const pool = makePool(() => Promise.resolve({ rows: [], rowCount: 0 }));
    const store = new PostgresBarStore(undefined, pool);

    await store.getRecentBars('AAPL', '1Day', 5);

    const selectCall = pool.query.mock.calls.find(([sql]: [string]) =>
      sqlContains(sql, 'SELECT', 'price_bars')
    );
    const [selectSql] = selectCall as [string];
    expect(sqlContains(selectSql, 'ORDER BY ts DESC')).toBe(true);
  });

  it('reverses DESC rows to return bars in oldest→newest order', async () => {
    // DB returns newest first (DESC order)
    const dbRows = [
      { ticker: 'AAPL', ts: T3, open: 106, high: 110, low: 105, close: 109, volume: 900_000 },
      { ticker: 'AAPL', ts: T2, open: 103, high: 107, low: 102, close: 106, volume: 1_200_000 },
      { ticker: 'AAPL', ts: T1, open: 100, high: 105, low: 99,  close: 103, volume: 1_000_000 },
    ];
    const pool = makePool(() => Promise.resolve({ rows: dbRows, rowCount: 3 }));
    const store = new PostgresBarStore(undefined, pool);

    const bars = await store.getRecentBars('AAPL', '1Day', 3);

    expect(bars).toHaveLength(3);
    // After reversal: T1 first, T3 last
    expect(bars[0]!.timestamp).toEqual(T1);
    expect(bars[1]!.timestamp).toEqual(T2);
    expect(bars[2]!.timestamp).toEqual(T3);
  });

  it('maps all PriceBar fields correctly from DB row', async () => {
    const dbRows = [
      { ticker: 'AAPL', ts: T1, open: 100, high: 105, low: 99, close: 103, volume: 1_000_000 },
    ];
    const pool = makePool(() => Promise.resolve({ rows: dbRows, rowCount: 1 }));
    const store = new PostgresBarStore(undefined, pool);

    const bars = await store.getRecentBars('AAPL', '1Day', 1);

    expect(bars).toHaveLength(1);
    const bar = bars[0]!;
    expect(bar.ticker).toBe('AAPL');
    expect(bar.timestamp).toEqual(T1);
    expect(bar.open).toBe(100);
    expect(bar.high).toBe(105);
    expect(bar.low).toBe(99);
    expect(bar.close).toBe(103);
    expect(bar.volume).toBe(1_000_000);
  });

  it('converts ts string to Date when pg returns string timestamps', async () => {
    const dbRows = [
      {
        ticker: 'SPY',
        ts: '2024-01-01T00:00:00.000Z', // string, not Date
        open: '400.5',
        high: '401.0',
        low: '399.0',
        close: '400.8',
        volume: '55000000',
      },
    ];
    const pool = makePool(() => Promise.resolve({ rows: dbRows, rowCount: 1 }));
    const store = new PostgresBarStore(undefined, pool);

    const bars = await store.getRecentBars('SPY', '1Day', 1);

    expect(bars[0]!.timestamp).toBeInstanceOf(Date);
    expect(bars[0]!.open).toBe(400.5);
  });

  it('returns [] when no bars exist', async () => {
    const pool = makePool(() => Promise.resolve({ rows: [], rowCount: 0 }));
    const store = new PostgresBarStore(undefined, pool);

    const bars = await store.getRecentBars('AAPL', '1Day', 10);

    expect(bars).toEqual([]);
  });

  it('returns [] and logs error on DB failure — never throws', async () => {
    const pool = makePool(() => Promise.reject(new Error('query timeout')));
    const store = new PostgresBarStore(undefined, pool);

    const bars = await store.getRecentBars('AAPL', '1Day', 10);

    expect(bars).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'PostgresBarStore.getRecentBars failed',
      expect.objectContaining({ error: 'query timeout' })
    );
  });
});

// ---------------------------------------------------------------------------
// count
// ---------------------------------------------------------------------------

describe('PostgresBarStore.count', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries COUNT(*) with correct ticker and timeframe', async () => {
    const pool = makePool(() =>
      Promise.resolve({ rows: [{ n: '42' }], rowCount: 1 })
    );
    const store = new PostgresBarStore(undefined, pool);

    await store.count('TSLA', '1Week');

    const countCall = pool.query.mock.calls.find(([sql]: [string]) =>
      sqlContains(sql, 'SELECT', 'COUNT', 'price_bars')
    );
    expect(countCall).toBeDefined();
    const params = countCall![1] as unknown[];
    expect(params).toEqual(['TSLA', '1Week']);
  });

  it('returns the integer count from the query result', async () => {
    const pool = makePool(() =>
      Promise.resolve({ rows: [{ n: '123' }], rowCount: 1 })
    );
    const store = new PostgresBarStore(undefined, pool);

    const n = await store.count('AAPL', '1Day');

    expect(n).toBe(123);
  });

  it('returns 0 when the table is empty', async () => {
    const pool = makePool(() =>
      Promise.resolve({ rows: [{ n: '0' }], rowCount: 1 })
    );
    const store = new PostgresBarStore(undefined, pool);

    const n = await store.count('AAPL', '1Day');

    expect(n).toBe(0);
  });

  it('returns 0 and logs error on DB failure — never throws', async () => {
    const pool = makePool(() => Promise.reject(new Error('connection lost')));
    const store = new PostgresBarStore(undefined, pool);

    const n = await store.count('AAPL', '1Day');

    expect(n).toBe(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'PostgresBarStore.count failed',
      expect.objectContaining({ error: 'connection lost' })
    );
  });
});

// ---------------------------------------------------------------------------
// Interface compliance
// ---------------------------------------------------------------------------

describe('PostgresBarStore interface compliance', () => {
  it('implements all three BarStore methods', () => {
    const pool = makePool();
    const store = new PostgresBarStore(undefined, pool);

    expect(typeof store.getRecentBars).toBe('function');
    expect(typeof store.upsertBars).toBe('function');
    expect(typeof store.count).toBe('function');
  });
});
