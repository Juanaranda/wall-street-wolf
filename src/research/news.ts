import axios from 'axios';
import { logger } from '../shared/logger';

/**
 * Fetch recent news headlines for a ticker from Finnhub (free tier).
 * Requires FINNHUB_API_KEY. Returns [] gracefully if unconfigured or on error
 * (never throws) so the sentiment gate degrades to the pure technical signal.
 */
export async function fetchRecentHeadlines(
  ticker: string,
  days = 7,
  limit = 8
): Promise<string[]> {
  const token = process.env['FINNHUB_API_KEY'];
  if (!token) return [];

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const to = new Date();
  const from = new Date(Date.now() - days * 86_400_000);

  try {
    const resp = await axios.get('https://finnhub.io/api/v1/company-news', {
      params: { symbol: ticker.toUpperCase(), from: fmt(from), to: fmt(to), token },
      timeout: 10_000,
    });
    const items: unknown[] = Array.isArray(resp.data) ? resp.data : [];
    return items
      .map((i) => String((i as { headline?: unknown }).headline ?? '').trim())
      .filter((h) => h.length > 0)
      .slice(0, limit);
  } catch (err) {
    logger.warn('fetchRecentHeadlines: failed', {
      ticker,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
