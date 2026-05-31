/**
 * Tests for AlpacaDataProvider (src/data/index.ts).
 * All network calls are mocked — no real HTTP requests.
 */

import axios from 'axios';
import { AlpacaDataProvider, MarketDataProvider } from '../src/data';
import { PriceBar } from '../src/shared/types';

// ---------------------------------------------------------------------------
// Mock axios
// ---------------------------------------------------------------------------

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

// axios.create returns a mock instance; we control that instance here.
const mockGet = jest.fn();
const mockAxiosInstance = {
  get: mockGet,
} as unknown as ReturnType<typeof axios.create>;

mockedAxios.create.mockReturnValue(mockAxiosInstance);
// Expose isAxiosError so the provider's error handler works in tests.
mockedAxios.isAxiosError.mockImplementation((err): err is ReturnType<typeof axios.isAxiosError> & object => {
  return (err as Record<string, unknown>)?.__isAxiosError === true;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAxiosError(status: number, data: unknown = {}): Record<string, unknown> {
  return {
    __isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status, data },
    isAxiosError: true,
  };
}

// Alpaca returns newest → oldest (sort=desc); the provider reverses to asc.
const FAKE_BARS_RESPONSE = {
  data: {
    bars: [
      { t: '2024-01-03T05:00:00Z', o: 187.2, h: 190.1, l: 186.0, c: 189.5, v: 48_000_000 },
      { t: '2024-01-02T05:00:00Z', o: 185.5, h: 188.0, l: 184.3, c: 187.2, v: 52_000_000 },
    ],
  },
};

const FAKE_LATEST_TRADE_RESPONSE = {
  data: {
    trade: { p: 189.5, t: '2024-01-03T20:00:00Z' },
  },
};

const FAKE_LATEST_QUOTE_RESPONSE = {
  data: {
    quote: { ap: 190.0, bp: 189.0, t: '2024-01-03T20:00:00Z' },
  },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Reset isAxiosError to baseline false
  mockedAxios.isAxiosError.mockImplementation(
    (err): err is ReturnType<typeof axios.isAxiosError> & object =>
      (err as Record<string, unknown>)?.__isAxiosError === true
  );
});

// ---------------------------------------------------------------------------
// getBars — happy path
// ---------------------------------------------------------------------------

describe('AlpacaDataProvider.getBars', () => {
  it('maps Alpaca bar fields to PriceBar correctly', async () => {
    mockGet.mockResolvedValueOnce(FAKE_BARS_RESPONSE);

    const provider: MarketDataProvider = new AlpacaDataProvider('key', 'secret');
    const bars: PriceBar[] = await provider.getBars('AAPL', '1Day', 2);

    expect(bars).toHaveLength(2);

    const [first, second] = bars;

    expect(first.ticker).toBe('AAPL');
    expect(first.open).toBe(185.5);
    expect(first.high).toBe(188.0);
    expect(first.low).toBe(184.3);
    expect(first.close).toBe(187.2);
    expect(first.volume).toBe(52_000_000);
    expect(first.timestamp).toEqual(new Date('2024-01-02T05:00:00Z'));

    expect(second.close).toBe(189.5);
  });

  it('calls the correct Alpaca endpoint with correct query params', async () => {
    mockGet.mockResolvedValueOnce(FAKE_BARS_RESPONSE);

    const provider = new AlpacaDataProvider('key', 'secret');
    await provider.getBars('MSFT', '1Hour', 50);

    expect(mockGet).toHaveBeenCalledWith('/v2/stocks/MSFT/bars', {
      params: expect.objectContaining({
        timeframe: '1Hour',
        limit: 50,
        sort: 'desc',
        feed: 'iex',
        adjustment: 'all',
        start: expect.any(String),
      }),
    });
  });

  it('normalises lowercase ticker to uppercase before calling the API', async () => {
    mockGet.mockResolvedValueOnce({ data: { bars: [] } });

    const provider = new AlpacaDataProvider('key', 'secret');
    await provider.getBars('aapl', '1Day', 10);

    expect(mockGet).toHaveBeenCalledWith('/v2/stocks/AAPL/bars', expect.any(Object));
  });

  it('returns [] and logs a warning when API keys are empty', async () => {
    const provider = new AlpacaDataProvider('', '');
    const bars = await provider.getBars('AAPL', '1Day', 10);

    expect(bars).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns [] and logs a warning for an invalid ticker', async () => {
    const provider = new AlpacaDataProvider('key', 'secret');
    const bars = await provider.getBars('', '1Day', 10);

    expect(bars).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns [] and logs a warning for a ticker with numbers/symbols', async () => {
    const provider = new AlpacaDataProvider('key', 'secret');
    const bars = await provider.getBars('AA PL!', '1Day', 10);

    expect(bars).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns [] when limit is 0 (invalid)', async () => {
    const provider = new AlpacaDataProvider('key', 'secret');
    const bars = await provider.getBars('AAPL', '1Day', 0);

    expect(bars).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns [] when limit is negative', async () => {
    const provider = new AlpacaDataProvider('key', 'secret');
    const bars = await provider.getBars('AAPL', '1Day', -5);

    expect(bars).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns [] gracefully on HTTP 401 (bad credentials)', async () => {
    mockGet.mockRejectedValue(makeAxiosError(401, { message: 'unauthorized' }));

    const provider = new AlpacaDataProvider('bad-key', 'bad-secret');
    const bars = await provider.getBars('AAPL', '1Day', 10);

    expect(bars).toEqual([]);
  });

  it('returns [] gracefully on HTTP 429 (rate limited) — exhausts retries', async () => {
    mockGet.mockRejectedValue(makeAxiosError(429, { message: 'too many requests' }));

    const provider = new AlpacaDataProvider('key', 'secret');
    const bars = await provider.getBars('AAPL', '1Day', 10);

    expect(bars).toEqual([]);
    // MAX_RETRIES = 2, so 3 total calls (attempt 0, 1, 2)
    expect(mockGet).toHaveBeenCalledTimes(3);
  }, 15_000);

  it('succeeds after one transient failure (retry logic)', async () => {
    mockGet
      .mockRejectedValueOnce(makeAxiosError(503, {}))
      .mockResolvedValueOnce(FAKE_BARS_RESPONSE);

    const provider = new AlpacaDataProvider('key', 'secret');
    const bars = await provider.getBars('AAPL', '1Day', 2);

    expect(bars).toHaveLength(2);
    expect(mockGet).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('handles empty bars array without throwing', async () => {
    mockGet.mockResolvedValueOnce({ data: { bars: [] } });

    const provider = new AlpacaDataProvider('key', 'secret');
    const bars = await provider.getBars('AAPL', '1Day', 100);

    expect(bars).toEqual([]);
  });

  it('does not throw on unexpected response shape', async () => {
    mockGet.mockResolvedValueOnce({ data: null });

    const provider = new AlpacaDataProvider('key', 'secret');
    const bars = await provider.getBars('AAPL', '1Day', 10);

    expect(bars).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getLatestPrice — happy path
// ---------------------------------------------------------------------------

describe('AlpacaDataProvider.getLatestPrice', () => {
  it('returns the latest trade price', async () => {
    mockGet.mockResolvedValueOnce(FAKE_LATEST_TRADE_RESPONSE);

    const provider = new AlpacaDataProvider('key', 'secret');
    const price = await provider.getLatestPrice('AAPL');

    expect(price).toBe(189.5);
  });

  it('calls the correct latest trades endpoint', async () => {
    mockGet.mockResolvedValueOnce(FAKE_LATEST_TRADE_RESPONSE);

    const provider = new AlpacaDataProvider('key', 'secret');
    await provider.getLatestPrice('AAPL');

    expect(mockGet).toHaveBeenCalledWith('/v2/stocks/AAPL/trades/latest');
  });

  it('falls back to quote midpoint when trade price is missing', async () => {
    // First call (trades): returns no valid price
    mockGet.mockResolvedValueOnce({ data: { trade: { p: null } } });
    // Second call (quotes): returns bid/ask
    mockGet.mockResolvedValueOnce(FAKE_LATEST_QUOTE_RESPONSE);

    const provider = new AlpacaDataProvider('key', 'secret');
    const price = await provider.getLatestPrice('AAPL');

    // Midpoint of 190.0 and 189.0
    expect(price).toBe(189.5);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('returns null and does not call API when keys are empty', async () => {
    const provider = new AlpacaDataProvider('', '');
    const price = await provider.getLatestPrice('AAPL');

    expect(price).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns null for an invalid ticker', async () => {
    const provider = new AlpacaDataProvider('key', 'secret');
    const price = await provider.getLatestPrice('123INVALID');

    expect(price).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('returns null gracefully on HTTP 404', async () => {
    mockGet.mockRejectedValue(makeAxiosError(404, { message: 'not found' }));

    const provider = new AlpacaDataProvider('key', 'secret');
    const price = await provider.getLatestPrice('AAPL');

    expect(price).toBeNull();
  });

  it('returns null gracefully on network timeout — exhausts retries', async () => {
    const networkErr = new Error('timeout of 10000ms exceeded');
    (networkErr as unknown as Record<string, unknown>).__isAxiosError = true;
    (networkErr as unknown as Record<string, unknown>).response = undefined;

    mockGet.mockRejectedValue(networkErr);

    const provider = new AlpacaDataProvider('key', 'secret');
    const price = await provider.getLatestPrice('AAPL');

    expect(price).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(3);
  }, 15_000);

  it('succeeds after one transient failure (retry logic)', async () => {
    mockGet
      .mockRejectedValueOnce(makeAxiosError(503, {}))
      .mockResolvedValueOnce(FAKE_LATEST_TRADE_RESPONSE);

    const provider = new AlpacaDataProvider('key', 'secret');
    const price = await provider.getLatestPrice('AAPL');

    expect(price).toBe(189.5);
    expect(mockGet).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('returns null when both trade and quote responses have no valid price', async () => {
    mockGet.mockResolvedValueOnce({ data: { trade: {} } });
    mockGet.mockResolvedValueOnce({ data: { quote: { ap: 0, bp: 0 } } });

    const provider = new AlpacaDataProvider('key', 'secret');
    const price = await provider.getLatestPrice('AAPL');

    expect(price).toBeNull();
  });

  it('normalises lowercase ticker to uppercase in the request URL', async () => {
    mockGet.mockResolvedValueOnce(FAKE_LATEST_TRADE_RESPONSE);

    const provider = new AlpacaDataProvider('key', 'secret');
    await provider.getLatestPrice('aapl');

    expect(mockGet).toHaveBeenCalledWith('/v2/stocks/AAPL/trades/latest');
  });
});

// ---------------------------------------------------------------------------
// Interface compliance
// ---------------------------------------------------------------------------

describe('AlpacaDataProvider interface compliance', () => {
  it('implements MarketDataProvider interface', () => {
    const provider: MarketDataProvider = new AlpacaDataProvider('key', 'secret');
    expect(typeof provider.getBars).toBe('function');
    expect(typeof provider.getLatestPrice).toBe('function');
  });

  it('can be instantiated with no arguments (defaults to empty keys)', () => {
    expect(() => new AlpacaDataProvider()).not.toThrow();
  });
});
