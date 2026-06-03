import axios from 'axios';
import { YahooDataProvider } from '../src/data/yahoo';

jest.mock('axios');
jest.mock('../src/shared/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

const mockedAxios = axios as jest.Mocked<typeof axios>;

function chart(timestamps: number[], close: (number | null)[], adjclose?: (number | null)[]) {
  return {
    data: {
      chart: {
        result: [
          {
            timestamp: timestamps,
            indicators: {
              quote: [{
                open: close, high: close, low: close, close, volume: close.map(() => 1000),
              }],
              adjclose: adjclose ? [{ adjclose }] : undefined,
            },
          },
        ],
      },
    },
  };
}

describe('YahooDataProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  it('parses chart JSON into PriceBars (oldest→newest)', async () => {
    const t0 = Math.floor(Date.parse('2024-01-02T00:00:00Z') / 1000);
    const t1 = t0 + 86400;
    mockedAxios.get.mockResolvedValueOnce(chart([t0, t1], [100, 110]));

    const bars = await new YahooDataProvider().getBars('AAPL', '1Day', 10);
    expect(bars).toHaveLength(2);
    expect(bars[0]!.close).toBeCloseTo(100);
    expect(bars[1]!.close).toBeCloseTo(110);
    expect(bars[0]!.ticker).toBe('AAPL');
  });

  it('applies the adjclose/close ratio to OHLC', async () => {
    const t0 = Math.floor(Date.now() / 1000);
    // close 100 but adjclose 90 → factor 0.9
    mockedAxios.get.mockResolvedValueOnce(chart([t0], [100], [90]));
    const bars = await new YahooDataProvider().getBars('AAPL', '1Day', 10);
    expect(bars[0]!.close).toBeCloseTo(90);
    expect(bars[0]!.open).toBeCloseTo(90);
  });

  it('skips rows with null close', async () => {
    const t0 = Math.floor(Date.now() / 1000);
    mockedAxios.get.mockResolvedValueOnce(chart([t0, t0 + 86400], [100, null]));
    const bars = await new YahooDataProvider().getBars('AAPL', '1Day', 10);
    expect(bars).toHaveLength(1);
  });

  it('truncates to the most recent `limit` bars', async () => {
    const base = Math.floor(Date.now() / 1000) - 10 * 86400;
    const ts = Array.from({ length: 10 }, (_, i) => base + i * 86400);
    const closes = ts.map((_, i) => 100 + i);
    mockedAxios.get.mockResolvedValueOnce(chart(ts, closes));
    const bars = await new YahooDataProvider().getBars('AAPL', '1Day', 3);
    expect(bars).toHaveLength(3);
    expect(bars[2]!.close).toBeCloseTo(109); // newest
  });

  it('returns [] on request failure (never throws)', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('network'));
    const bars = await new YahooDataProvider().getBars('AAPL', '1Day', 10);
    expect(bars).toEqual([]);
  });

  it('getLatestPrice returns the most recent close', async () => {
    const t0 = Math.floor(Date.now() / 1000);
    mockedAxios.get.mockResolvedValueOnce(chart([t0 - 86400, t0], [100, 105]));
    const price = await new YahooDataProvider().getLatestPrice('AAPL');
    expect(price).toBeCloseTo(105);
  });
});
