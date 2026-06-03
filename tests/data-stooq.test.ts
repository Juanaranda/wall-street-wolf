/**
 * Tests for StooqDataProvider (src/data/stooq.ts).
 * All network calls are mocked — no real HTTP requests.
 */

import axios from 'axios';
import { StooqDataProvider, toStooqSymbol, toStooqInterval, parseStooqCsv } from '../src/data/stooq';
import { MarketDataProvider } from '../src/data';
import { PriceBar } from '../src/shared/types';

// ---------------------------------------------------------------------------
// Mock axios
// ---------------------------------------------------------------------------

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

mockedAxios.isAxiosError.mockImplementation(
  (err): err is ReturnType<typeof axios.isAxiosError> & object =>
    (err as Record<string, unknown>)?.__isAxiosError === true
);

// ---------------------------------------------------------------------------
// Sample CSV fixtures
// ---------------------------------------------------------------------------

/** Minimal valid CSV, three bars, oldest first. */
const SAMPLE_CSV_3_BARS = [
  'Date,Open,High,Low,Close,Volume',
  '2020-01-02,296.24,300.60,295.19,300.35,33870100',
  '2020-01-03,297.15,300.58,296.50,297.43,36580700',
  '2020-01-06,293.79,299.96,292.75,299.80,29596800',
].join('\n');

/** Ten-bar CSV for limit-truncation tests. */
const TEN_ROWS: string[] = [
  'Date,Open,High,Low,Close,Volume',
];
for (let d = 1; d <= 10; d++) {
  const day = String(d).padStart(2, '0');
  TEN_ROWS.push(`2024-01-${day},100.00,105.00,99.00,${100 + d}.00,1000000`);
}
const SAMPLE_CSV_10_BARS = TEN_ROWS.join('\n');

/** CSV with one N/D row interspersed. */
const SAMPLE_CSV_WITH_ND = [
  'Date,Open,High,Low,Close,Volume',
  '2023-01-02,150.00,155.00,149.00,154.00,20000000',
  '2023-01-03,N/D,N/D,N/D,N/D,N/D',
  '2023-01-04,155.00,160.00,154.00,158.00,22000000',
].join('\n');

/** CSV with a malformed row (too few columns). */
const SAMPLE_CSV_WITH_MALFORMED = [
  'Date,Open,High,Low,Close,Volume',
  '2023-01-02,150.00,155.00,149.00,154.00,20000000',
  '2023-01-03,155.00',   // only 2 columns
  '2023-01-04,158.00,162.00,157.00,161.00,21000000',
].join('\n');

/** Empty response body. */
const EMPTY_CSV = '';

/** Only the header row, no data. */
const HEADER_ONLY_CSV = 'Date,Open,High,Low,Close,Volume\n';

/** CSV with a row where numbers are not valid floats. */
const SAMPLE_CSV_WITH_NAN_ROW = [
  'Date,Open,High,Low,Close,Volume',
  '2023-01-02,abc,def,ghi,jkl,mno',
  '2023-01-04,155.00,160.00,154.00,158.00,22000000',
].join('\n');

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

function makeAxiosResponse(csvText: string) {
  return Promise.resolve({ data: csvText, status: 200, headers: {} });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.isAxiosError.mockImplementation(
    (err): err is ReturnType<typeof axios.isAxiosError> & object =>
      (err as Record<string, unknown>)?.__isAxiosError === true
  );
});

// ---------------------------------------------------------------------------
// toStooqSymbol — symbol mapping
// ---------------------------------------------------------------------------

describe('toStooqSymbol', () => {
  it('converts uppercase US ticker to lowercase + .us suffix', () => {
    expect(toStooqSymbol('AAPL')).toBe('aapl.us');
  });

  it('converts SPY correctly', () => {
    expect(toStooqSymbol('SPY')).toBe('spy.us');
  });

  it('converts BRK.B to brk-b.us (dot → hyphen)', () => {
    expect(toStooqSymbol('BRK.B')).toBe('brk-b.us');
  });

  it('converts lowercase brk.b to brk-b.us', () => {
    expect(toStooqSymbol('brk.b')).toBe('brk-b.us');
  });

  it('converts MSFT correctly', () => {
    expect(toStooqSymbol('MSFT')).toBe('msft.us');
  });

  it('trims leading/trailing whitespace before conversion', () => {
    expect(toStooqSymbol('  AAPL  ')).toBe('aapl.us');
  });

  it('converts a ticker with multiple dots (e.g. A.B.C)', () => {
    expect(toStooqSymbol('A.B.C')).toBe('a-b-c.us');
  });
});

// ---------------------------------------------------------------------------
// toStooqInterval — interval mapping
// ---------------------------------------------------------------------------

describe('toStooqInterval', () => {
  it('maps 1Day to d', () => {
    expect(toStooqInterval('1Day')).toBe('d');
  });

  it('maps 1Week to w', () => {
    expect(toStooqInterval('1Week')).toBe('w');
  });

  it('maps 1Month to m', () => {
    expect(toStooqInterval('1Month')).toBe('m');
  });

  it('defaults to d for unknown timeframe', () => {
    expect(toStooqInterval('1Hour')).toBe('d');
  });

  it('defaults to d for empty string', () => {
    expect(toStooqInterval('')).toBe('d');
  });
});

// ---------------------------------------------------------------------------
// parseStooqCsv — CSV parsing unit tests
// ---------------------------------------------------------------------------

describe('parseStooqCsv', () => {
  it('parses a valid CSV into correctly shaped PriceBars', () => {
    const bars = parseStooqCsv('AAPL', SAMPLE_CSV_3_BARS);

    expect(bars).toHaveLength(3);

    const first = bars[0]!;
    expect(first.ticker).toBe('AAPL');
    expect(first.timestamp).toEqual(new Date('2020-01-02'));
    expect(first.open).toBe(296.24);
    expect(first.high).toBe(300.60);
    expect(first.low).toBe(295.19);
    expect(first.close).toBe(300.35);
    expect(first.volume).toBe(33870100);
  });

  it('preserves oldest → newest ordering', () => {
    const bars = parseStooqCsv('AAPL', SAMPLE_CSV_3_BARS);
    expect(bars[0]!.timestamp.getTime()).toBeLessThan(bars[1]!.timestamp.getTime());
    expect(bars[1]!.timestamp.getTime()).toBeLessThan(bars[2]!.timestamp.getTime());
  });

  it('assigns the given ticker to every bar', () => {
    const bars = parseStooqCsv('SPY', SAMPLE_CSV_3_BARS);
    bars.forEach((b) => expect(b.ticker).toBe('SPY'));
  });

  it('skips rows where any OHLCV field is N/D', () => {
    const bars = parseStooqCsv('AAPL', SAMPLE_CSV_WITH_ND);
    expect(bars).toHaveLength(2);
    // The N/D row for 2023-01-03 should be absent
    const dates = bars.map((b) => b.timestamp.toISOString().slice(0, 10));
    expect(dates).not.toContain('2023-01-03');
  });

  it('skips rows with fewer than 6 columns', () => {
    const bars = parseStooqCsv('AAPL', SAMPLE_CSV_WITH_MALFORMED);
    expect(bars).toHaveLength(2);
  });

  it('skips rows where numeric fields are not parseable numbers', () => {
    const bars = parseStooqCsv('AAPL', SAMPLE_CSV_WITH_NAN_ROW);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.close).toBe(158.00);
  });

  it('returns [] for empty CSV', () => {
    expect(parseStooqCsv('AAPL', EMPTY_CSV)).toEqual([]);
  });

  it('returns [] for header-only CSV', () => {
    expect(parseStooqCsv('AAPL', HEADER_ONLY_CSV)).toEqual([]);
  });

  it('returns [] for a CSV with no recognisable header', () => {
    const badCsv = 'foo,bar,baz\n1,2,3';
    expect(parseStooqCsv('AAPL', badCsv)).toEqual([]);
  });

  it('handles CRLF line endings without corrupting values', () => {
    const crlfCsv = 'Date,Open,High,Low,Close,Volume\r\n2024-01-02,150.00,155.00,149.00,154.00,20000000\r\n';
    const bars = parseStooqCsv('AAPL', crlfCsv);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.close).toBe(154.00);
  });
});

// ---------------------------------------------------------------------------
// StooqDataProvider.getBars
// ---------------------------------------------------------------------------

describe('StooqDataProvider.getBars', () => {
  it('returns correctly shaped PriceBars on a valid response', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(SAMPLE_CSV_3_BARS));

    const provider: MarketDataProvider = new StooqDataProvider();
    const bars: PriceBar[] = await provider.getBars('AAPL', '1Day', 100);

    expect(bars).toHaveLength(3);
    expect(bars[0]!.ticker).toBe('AAPL');
    expect(bars[0]!.open).toBe(296.24);
    expect(bars[2]!.close).toBe(299.80);
  });

  it('calls the correct Stooq URL for AAPL daily', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(SAMPLE_CSV_3_BARS));

    const provider = new StooqDataProvider();
    await provider.getBars('AAPL', '1Day', 10);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://stooq.com/q/d/l/?s=aapl.us&i=d',
      expect.objectContaining({ timeout: expect.any(Number), responseType: 'text' })
    );
  });

  it('calls the correct Stooq URL for BRK.B (dot → hyphen)', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(SAMPLE_CSV_3_BARS));

    const provider = new StooqDataProvider();
    await provider.getBars('BRK.B', '1Day', 10);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://stooq.com/q/d/l/?s=brk-b.us&i=d',
      expect.any(Object)
    );
  });

  it('uses interval w for 1Week timeframe', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(SAMPLE_CSV_3_BARS));

    const provider = new StooqDataProvider();
    await provider.getBars('SPY', '1Week', 10);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://stooq.com/q/d/l/?s=spy.us&i=w',
      expect.any(Object)
    );
  });

  it('uses interval m for 1Month timeframe', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(SAMPLE_CSV_3_BARS));

    const provider = new StooqDataProvider();
    await provider.getBars('SPY', '1Month', 10);

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://stooq.com/q/d/l/?s=spy.us&i=m',
      expect.any(Object)
    );
  });

  it('truncates to the LAST `limit` bars when more rows are available', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(SAMPLE_CSV_10_BARS));

    const provider = new StooqDataProvider();
    const bars = await provider.getBars('AAPL', '1Day', 3);

    expect(bars).toHaveLength(3);
    // The last 3 bars in the 10-bar fixture are days 8, 9, 10
    expect(bars[2]!.close).toBe(110.00); // day 10: close = 100 + 10
    expect(bars[1]!.close).toBe(109.00); // day 9
    expect(bars[0]!.close).toBe(108.00); // day 8
  });

  it('returns all bars when limit exceeds row count', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(SAMPLE_CSV_3_BARS));

    const provider = new StooqDataProvider();
    const bars = await provider.getBars('AAPL', '1Day', 1000);

    expect(bars).toHaveLength(3);
  });

  it('returns [] for an empty CSV body', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(EMPTY_CSV));

    const provider = new StooqDataProvider();
    const bars = await provider.getBars('AAPL', '1Day', 10);

    expect(bars).toEqual([]);
  });

  it('returns [] for a header-only CSV', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(HEADER_ONLY_CSV));

    const provider = new StooqDataProvider();
    const bars = await provider.getBars('AAPL', '1Day', 10);

    expect(bars).toEqual([]);
  });

  it('returns [] and does not throw on HTTP 404', async () => {
    mockedAxios.get.mockRejectedValueOnce(makeAxiosError(404));

    const provider = new StooqDataProvider();
    await expect(provider.getBars('AAPL', '1Day', 10)).resolves.toEqual([]);
  });

  it('returns [] and does not throw on network timeout', async () => {
    const timeoutErr = new Error('timeout of 15000ms exceeded');
    (timeoutErr as unknown as Record<string, unknown>).__isAxiosError = true;
    mockedAxios.get.mockRejectedValueOnce(timeoutErr);

    const provider = new StooqDataProvider();
    await expect(provider.getBars('AAPL', '1Day', 10)).resolves.toEqual([]);
  });

  it('returns [] for an invalid ticker (empty string)', async () => {
    const provider = new StooqDataProvider();
    const bars = await provider.getBars('', '1Day', 10);

    expect(bars).toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('returns [] for an invalid ticker (starts with digit)', async () => {
    const provider = new StooqDataProvider();
    const bars = await provider.getBars('1AAPL', '1Day', 10);

    expect(bars).toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('returns [] for an invalid limit of 0', async () => {
    const provider = new StooqDataProvider();
    const bars = await provider.getBars('AAPL', '1Day', 0);

    expect(bars).toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('returns [] for a negative limit', async () => {
    const provider = new StooqDataProvider();
    const bars = await provider.getBars('AAPL', '1Day', -5);

    expect(bars).toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('normalises the ticker to uppercase before assigning to bars', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(SAMPLE_CSV_3_BARS));

    const provider = new StooqDataProvider();
    const bars = await provider.getBars('aapl', '1Day', 100);

    // All bars should carry the uppercase form
    bars.forEach((b) => expect(b.ticker).toBe('AAPL'));
  });

  it('skips N/D rows and only returns valid bars', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(SAMPLE_CSV_WITH_ND));

    const provider = new StooqDataProvider();
    const bars = await provider.getBars('AAPL', '1Day', 100);

    expect(bars).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// StooqDataProvider.getLatestPrice
// ---------------------------------------------------------------------------

describe('StooqDataProvider.getLatestPrice', () => {
  it('returns the close price of the most recent bar', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(SAMPLE_CSV_3_BARS));

    const provider: MarketDataProvider = new StooqDataProvider();
    const price = await provider.getLatestPrice('AAPL');

    // Most recent bar (2020-01-06) has close = 299.80
    expect(price).toBe(299.80);
  });

  it('returns null for an empty CSV response', async () => {
    mockedAxios.get.mockReturnValueOnce(makeAxiosResponse(EMPTY_CSV));

    const provider = new StooqDataProvider();
    const price = await provider.getLatestPrice('AAPL');

    expect(price).toBeNull();
  });

  it('returns null when the request fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(makeAxiosError(500));

    const provider = new StooqDataProvider();
    const price = await provider.getLatestPrice('AAPL');

    expect(price).toBeNull();
  });

  it('returns null for an invalid ticker', async () => {
    const provider = new StooqDataProvider();
    const price = await provider.getLatestPrice('');

    expect(price).toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('does not throw on any error path', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('catastrophic failure'));

    const provider = new StooqDataProvider();
    await expect(provider.getLatestPrice('AAPL')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Interface compliance
// ---------------------------------------------------------------------------

describe('StooqDataProvider interface compliance', () => {
  it('implements MarketDataProvider', () => {
    const provider: MarketDataProvider = new StooqDataProvider();
    expect(typeof provider.getBars).toBe('function');
    expect(typeof provider.getLatestPrice).toBe('function');
  });

  it('can be instantiated with no arguments', () => {
    expect(() => new StooqDataProvider()).not.toThrow();
  });
});
