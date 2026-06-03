/**
 * Tests for CachedDataProvider (src/data/cached.ts).
 *
 * No network, no database — source and store are plain objects with jest.fn().
 */

import { CachedDataProvider } from '../src/data/cached';
import { MarketDataProvider } from '../src/data';
import { BarStore } from '../src/data/types';
import { PriceBar } from '../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBar(ticker: string, close: number, daysAgo: number): PriceBar {
  return {
    ticker,
    timestamp: new Date(Date.now() - daysAgo * 86_400_000),
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 1_000_000,
  };
}

function makeSource(
  overrides: Partial<{
    getBars: jest.Mock;
    getLatestPrice: jest.Mock;
  }> = {},
): jest.Mocked<MarketDataProvider> {
  return {
    getBars: overrides.getBars ?? jest.fn().mockResolvedValue([]),
    getLatestPrice: overrides.getLatestPrice ?? jest.fn().mockResolvedValue(null),
  };
}

function makeStore(
  overrides: Partial<{
    getRecentBars: jest.Mock;
    upsertBars: jest.Mock;
    count: jest.Mock;
  }> = {},
): jest.Mocked<BarStore> {
  return {
    getRecentBars: overrides.getRecentBars ?? jest.fn().mockResolvedValue([]),
    upsertBars: overrides.upsertBars ?? jest.fn().mockResolvedValue(0),
    count: overrides.count ?? jest.fn().mockResolvedValue(0),
  };
}

// ---------------------------------------------------------------------------
// Cache hit: store already has enough bars
// ---------------------------------------------------------------------------

describe('getBars — cache hit', () => {
  it('returns cached bars without calling the source', async () => {
    const limit = 3;
    const cachedBars = [
      makeBar('AAPL', 180, 3),
      makeBar('AAPL', 181, 2),
      makeBar('AAPL', 182, 1),
    ];

    const store = makeStore({
      getRecentBars: jest.fn().mockResolvedValue(cachedBars),
    });
    const source = makeSource();

    const provider = new CachedDataProvider(source, store, 'alpaca');
    const result = await provider.getBars('AAPL', '1Day', limit);

    expect(result).toEqual(cachedBars);
    expect(store.getRecentBars).toHaveBeenCalledWith('AAPL', '1Day', limit);
    expect(source.getBars).not.toHaveBeenCalled();
    expect(store.upsertBars).not.toHaveBeenCalled();
  });

  it('treats store returning exactly limit bars as a hit', async () => {
    const limit = 2;
    const cachedBars = [makeBar('MSFT', 300, 2), makeBar('MSFT', 302, 1)];

    const store = makeStore({
      getRecentBars: jest.fn().mockResolvedValue(cachedBars),
    });
    const source = makeSource();

    const provider = new CachedDataProvider(source, store);
    const result = await provider.getBars('MSFT', '1Hour', limit);

    expect(result).toEqual(cachedBars);
    expect(source.getBars).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cache miss: store has fewer bars than requested
// ---------------------------------------------------------------------------

describe('getBars — cache miss', () => {
  it('calls the source, upserts the result, and returns fetched bars', async () => {
    const limit = 5;
    const partialCache = [makeBar('TSLA', 200, 1)]; // only 1 bar in store
    const sourceBars = [
      makeBar('TSLA', 196, 5),
      makeBar('TSLA', 197, 4),
      makeBar('TSLA', 198, 3),
      makeBar('TSLA', 199, 2),
      makeBar('TSLA', 200, 1),
    ];

    const store = makeStore({
      getRecentBars: jest.fn().mockResolvedValue(partialCache),
      upsertBars: jest.fn().mockResolvedValue(5),
    });
    const source = makeSource({
      getBars: jest.fn().mockResolvedValue(sourceBars),
    });

    const provider = new CachedDataProvider(source, store, 'stooq');
    const result = await provider.getBars('TSLA', '1Day', limit);

    expect(result).toEqual(sourceBars);
    expect(source.getBars).toHaveBeenCalledWith('TSLA', '1Day', limit);
    expect(store.upsertBars).toHaveBeenCalledWith('1Day', sourceBars, 'stooq');
  });

  it('passes the correct sourceName to upsertBars', async () => {
    const sourceBars = [makeBar('GOOG', 170, 1)];
    const store = makeStore({
      getRecentBars: jest.fn().mockResolvedValue([]),
      upsertBars: jest.fn().mockResolvedValue(1),
    });
    const source = makeSource({
      getBars: jest.fn().mockResolvedValue(sourceBars),
    });

    const provider = new CachedDataProvider(source, store, 'my-custom-source');
    await provider.getBars('GOOG', '1Day', 1);

    expect(store.upsertBars).toHaveBeenCalledWith('1Day', sourceBars, 'my-custom-source');
  });

  it('uses default sourceName "source" when none is provided', async () => {
    const sourceBars = [makeBar('AMZN', 190, 1)];
    const store = makeStore({
      getRecentBars: jest.fn().mockResolvedValue([]),
      upsertBars: jest.fn().mockResolvedValue(1),
    });
    const source = makeSource({
      getBars: jest.fn().mockResolvedValue(sourceBars),
    });

    const provider = new CachedDataProvider(source, store);
    await provider.getBars('AMZN', '1Day', 1);

    expect(store.upsertBars).toHaveBeenCalledWith('1Day', sourceBars, 'source');
  });
});

// ---------------------------------------------------------------------------
// Source-empty fallback
// ---------------------------------------------------------------------------

describe('getBars — source returns empty', () => {
  it('returns cached bars when the source comes back empty', async () => {
    const partialCache = [makeBar('SPY', 450, 1)];
    const store = makeStore({
      getRecentBars: jest.fn().mockResolvedValue(partialCache),
      upsertBars: jest.fn(),
    });
    const source = makeSource({
      getBars: jest.fn().mockResolvedValue([]),
    });

    const provider = new CachedDataProvider(source, store, 'alpaca');
    const result = await provider.getBars('SPY', '1Day', 10);

    expect(result).toEqual(partialCache);
    expect(store.upsertBars).not.toHaveBeenCalled();
  });

  it('returns an empty array when both store and source are empty', async () => {
    const store = makeStore({
      getRecentBars: jest.fn().mockResolvedValue([]),
    });
    const source = makeSource({
      getBars: jest.fn().mockResolvedValue([]),
    });

    const provider = new CachedDataProvider(source, store, 'alpaca');
    const result = await provider.getBars('XYZ', '1Day', 5);

    expect(result).toEqual([]);
    expect(store.upsertBars).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getLatestPrice — always delegates to the live source
// ---------------------------------------------------------------------------

describe('getLatestPrice', () => {
  it('delegates to source and returns the live price', async () => {
    const source = makeSource({
      getLatestPrice: jest.fn().mockResolvedValue(189.5),
    });
    const store = makeStore();

    const provider = new CachedDataProvider(source, store, 'alpaca');
    const price = await provider.getLatestPrice('AAPL');

    expect(price).toBe(189.5);
    expect(source.getLatestPrice).toHaveBeenCalledWith('AAPL');
  });

  it('returns null when the source has no price', async () => {
    const source = makeSource({
      getLatestPrice: jest.fn().mockResolvedValue(null),
    });
    const store = makeStore();

    const provider = new CachedDataProvider(source, store);
    const price = await provider.getLatestPrice('UNKN');

    expect(price).toBeNull();
    expect(source.getLatestPrice).toHaveBeenCalledWith('UNKN');
  });

  it('never reads from the store for latest price', async () => {
    const source = makeSource({
      getLatestPrice: jest.fn().mockResolvedValue(300),
    });
    const store = makeStore();

    const provider = new CachedDataProvider(source, store, 'alpaca');
    await provider.getLatestPrice('MSFT');

    expect(store.getRecentBars).not.toHaveBeenCalled();
    expect(store.upsertBars).not.toHaveBeenCalled();
    expect(store.count).not.toHaveBeenCalled();
  });
});
