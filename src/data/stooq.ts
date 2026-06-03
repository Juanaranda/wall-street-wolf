import axios from 'axios';
import { MarketDataProvider } from './index';
import { PriceBar } from '../shared/types';
import { logger } from '../shared/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STOOQ_BASE_URL = 'https://stooq.com/q/d/l/';
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Raw CSV columns parsed from a Stooq response row. */
interface StooqRow {
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a US ticker to the Stooq symbol format.
 *
 * Rules:
 * - Lowercase the ticker.
 * - Replace any dot (.) with a hyphen (-) so BRK.B → brk-b.
 * - Append the `.us` suffix.
 *
 * Examples:
 *   AAPL   → aapl.us
 *   SPY    → spy.us
 *   BRK.B  → brk-b.us
 *   brk.b  → brk-b.us  (already lowercase)
 */
export function toStooqSymbol(ticker: string): string {
  return ticker.trim().toLowerCase().replace(/\./g, '-') + '.us';
}

/**
 * Map a timeframe string to the Stooq interval parameter.
 *
 * Supported mappings:
 *   '1Day'   → 'd'
 *   '1Week'  → 'w'
 *   '1Month' → 'm'
 *
 * Defaults to 'd' (daily) for unrecognised values.
 */
export function toStooqInterval(timeframe: string): string {
  const map: Record<string, string> = {
    '1Day': 'd',
    '1Week': 'w',
    '1Month': 'm',
  };
  return map[timeframe] ?? 'd';
}

/**
 * Validate a ticker string.
 * Accepts letters, digits, dots, and hyphens (covers BRK.B, BRK-B, etc.).
 */
function isValidTicker(ticker: string): boolean {
  return (
    typeof ticker === 'string' &&
    ticker.trim().length > 0 &&
    /^[A-Za-z][A-Za-z0-9.\-]{0,14}$/.test(ticker.trim())
  );
}

/** Validate that limit is a positive finite integer in a reasonable range. */
function isValidLimit(limit: number): boolean {
  return Number.isInteger(limit) && limit >= 1 && limit <= 100_000;
}

/**
 * Check whether a CSV field value represents a missing/not-available value.
 * Stooq uses "N/D" for missing data.
 */
function isNaValue(value: string): boolean {
  const v = value.trim().toUpperCase();
  return v === 'N/D' || v === '' || v === 'N/A' || v === 'NULL';
}

/**
 * Parse a Stooq CSV response into an array of PriceBars.
 *
 * The CSV format is (header line is always present):
 *   Date,Open,High,Low,Close,Volume
 *   2024-01-02,185.50,188.00,184.30,187.20,52000000
 *   ...
 *
 * Rows with any N/D value, malformed numbers, or missing columns are skipped.
 * The CSV is returned oldest → newest by Stooq; we preserve that ordering.
 */
export function parseStooqCsv(ticker: string, csv: string): PriceBar[] {
  const lines = csv.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  // Must have at least a header + one data row.
  if (lines.length < 2) {
    return [];
  }

  // Validate header structure (case-insensitive).
  const header = lines[0]!.toLowerCase();
  if (
    !header.includes('date') ||
    !header.includes('open') ||
    !header.includes('close')
  ) {
    logger.warn('StooqDataProvider: unexpected CSV header', { ticker, header });
    return [];
  }

  const bars: PriceBar[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const parts = line.split(',');

    // Expect exactly 6 columns: Date, Open, High, Low, Close, Volume
    if (parts.length < 6) {
      logger.debug('StooqDataProvider: skipping malformed CSV row', { ticker, row: line });
      continue;
    }

    const row: StooqRow = {
      date: parts[0]!.trim(),
      open: parts[1]!.trim(),
      high: parts[2]!.trim(),
      low: parts[3]!.trim(),
      close: parts[4]!.trim(),
      volume: parts[5]!.trim(),
    };

    // Skip rows with N/D or missing values in any OHLCV field.
    if (
      isNaValue(row.date) ||
      isNaValue(row.open) ||
      isNaValue(row.high) ||
      isNaValue(row.low) ||
      isNaValue(row.close) ||
      isNaValue(row.volume)
    ) {
      logger.debug('StooqDataProvider: skipping N/D row', { ticker, row: line });
      continue;
    }

    const timestamp = new Date(row.date);
    const open = parseFloat(row.open);
    const high = parseFloat(row.high);
    const low = parseFloat(row.low);
    const close = parseFloat(row.close);
    const volume = parseFloat(row.volume);

    // Skip rows with invalid numbers.
    if (
      isNaN(timestamp.getTime()) ||
      isNaN(open) ||
      isNaN(high) ||
      isNaN(low) ||
      isNaN(close) ||
      isNaN(volume)
    ) {
      logger.debug('StooqDataProvider: skipping row with non-numeric values', {
        ticker,
        row: line,
      });
      continue;
    }

    bars.push({ ticker, timestamp, open, high, low, close, volume });
  }

  return bars;
}

// ---------------------------------------------------------------------------
// StooqDataProvider
// ---------------------------------------------------------------------------

/**
 * Market-data provider backed by Stooq's free CSV endpoint.
 *
 * Stooq provides daily/weekly/monthly OHLCV history for US stocks and ETFs
 * going back 20+ years with no API key required.
 *
 * Usage:
 *   const stooq = new StooqDataProvider();
 *   const bars = await stooq.getBars('AAPL', '1Day', 250);
 *
 * On any error (network, bad CSV, validation failure) the methods log a
 * warning and return [] or null. They NEVER throw.
 */
export class StooqDataProvider implements MarketDataProvider {
  /**
   * Fetch historical OHLCV bars for a US stock or ETF.
   *
   * @param ticker    - US ticker symbol, e.g. 'AAPL', 'SPY', 'BRK.B'
   * @param timeframe - '1Day' | '1Week' | '1Month' (defaults to daily for unknown values)
   * @param limit     - Maximum number of bars to return (most recent bars)
   * @returns Array of PriceBars ordered oldest → newest, at most `limit` entries
   */
  async getBars(ticker: string, timeframe: string, limit: number): Promise<PriceBar[]> {
    if (!isValidTicker(ticker)) {
      logger.warn('StooqDataProvider.getBars: invalid ticker', { ticker });
      return [];
    }

    if (!isValidLimit(limit)) {
      logger.warn('StooqDataProvider.getBars: invalid limit', { limit });
      return [];
    }

    const symbol = toStooqSymbol(ticker);
    const interval = toStooqInterval(timeframe);
    const url = `${STOOQ_BASE_URL}?s=${symbol}&i=${interval}`;

    try {
      const response = await axios.get<string>(url, {
        timeout: REQUEST_TIMEOUT_MS,
        responseType: 'text',
        // Prevent axios from interpreting the CSV as JSON
        transformResponse: [(data: string) => data],
      });

      const csv: string = response.data ?? '';

      if (!csv || csv.trim().length === 0) {
        logger.warn('StooqDataProvider.getBars: empty response', { ticker, symbol });
        return [];
      }

      const allBars = parseStooqCsv(ticker.trim().toUpperCase(), csv);

      if (allBars.length === 0) {
        logger.warn('StooqDataProvider.getBars: no valid bars parsed', { ticker, symbol });
        return [];
      }

      // Return the LAST `limit` bars (most recent), preserving oldest→newest order.
      return allBars.length > limit ? allBars.slice(allBars.length - limit) : allBars;
    } catch (err: unknown) {
      logger.warn('StooqDataProvider.getBars: request failed', {
        ticker,
        symbol,
        error: extractErrorMessage(err),
      });
      return [];
    }
  }

  /**
   * Fetch the most recent closing price for a US stock or ETF.
   *
   * Internally fetches a single daily bar from Stooq and returns its close price.
   *
   * @param ticker - US ticker symbol, e.g. 'AAPL'
   * @returns Most recent close price, or null if unavailable
   */
  async getLatestPrice(ticker: string): Promise<number | null> {
    if (!isValidTicker(ticker)) {
      logger.warn('StooqDataProvider.getLatestPrice: invalid ticker', { ticker });
      return null;
    }

    // Fetch up to 5 bars so we get the most recent one robustly,
    // even if the very last row happens to be partially formed.
    const bars = await this.getBars(ticker, '1Day', 5);

    if (bars.length === 0) {
      return null;
    }

    // The last element is the most recent bar.
    const latestBar = bars[bars.length - 1]!;
    return latestBar.close;
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
