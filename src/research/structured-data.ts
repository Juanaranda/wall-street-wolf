/**
 * Structured data sources by category.
 * All use free/no-key APIs where possible.
 */
import axios from 'axios';
import { logger } from '../shared/logger';

export interface StructuredDataPoint {
  label: string;
  value: string;
  relevance: 'high' | 'medium' | 'low';
}

/** CoinGecko — free crypto prices + market data (no API key needed) */
async function fetchCryptoData(question: string): Promise<StructuredDataPoint[]> {
  const COIN_MAP: Record<string, string> = {
    bitcoin: 'bitcoin', btc: 'bitcoin',
    ethereum: 'ethereum', eth: 'ethereum',
    solana: 'solana', sol: 'solana',
    xrp: 'ripple', ripple: 'ripple',
    doge: 'dogecoin', dogecoin: 'dogecoin',
    bnb: 'binancecoin',
  };

  const lq = question.toLowerCase();
  const coinId = Object.entries(COIN_MAP).find(([k]) => lq.includes(k))?.[1];
  if (!coinId) return [];

  try {
    const { data } = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${coinId}`,
      {
        params: { localization: false, tickers: false, community_data: false, developer_data: false },
        timeout: 6000,
      }
    );
    const p = data.market_data;
    return [
      { label: `${data.name} current price`, value: `$${p.current_price.usd.toLocaleString()}`, relevance: 'high' },
      { label: '24h change', value: `${p.price_change_percentage_24h?.toFixed(2)}%`, relevance: 'high' },
      { label: '7d change', value: `${p.price_change_percentage_7d?.toFixed(2)}%`, relevance: 'medium' },
      { label: 'All-time high', value: `$${p.ath.usd.toLocaleString()}`, relevance: 'low' },
      { label: 'Market cap rank', value: `#${data.market_cap_rank}`, relevance: 'medium' },
      { label: 'Sentiment (thumbs up)', value: `${data.sentiment_votes_up_percentage?.toFixed(0)}%`, relevance: 'medium' },
    ];
  } catch (err) {
    logger.debug('StructuredData: CoinGecko fetch failed', { coinId, err });
    return [];
  }
}

/** Open-Meteo — free weather forecasts (no API key) */
async function fetchWeatherData(question: string): Promise<StructuredDataPoint[]> {
  // Only fetch if question contains a known city — simplified to just note availability
  const cities: Record<string, { lat: number; lon: number }> = {
    'new york': { lat: 40.71, lon: -74.01 },
    'los angeles': { lat: 34.05, lon: -118.24 },
    'chicago': { lat: 41.88, lon: -87.63 },
    'miami': { lat: 25.77, lon: -80.19 },
    'london': { lat: 51.51, lon: -0.13 },
  };
  const lq = question.toLowerCase();
  const city = Object.entries(cities).find(([name]) => lq.includes(name));
  if (!city) return [];

  try {
    const { data } = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: city[1].lat,
        longitude: city[1].lon,
        daily: 'temperature_2m_max,precipitation_sum,windspeed_10m_max',
        forecast_days: 3,
        timezone: 'auto',
      },
      timeout: 5000,
    });
    const d = data.daily;
    return [
      { label: `${city[0]} max temp today`, value: `${d.temperature_2m_max[0]}°C`, relevance: 'high' },
      { label: 'Precipitation today', value: `${d.precipitation_sum[0]}mm`, relevance: 'high' },
      { label: 'Max wind today', value: `${d.windspeed_10m_max[0]} km/h`, relevance: 'medium' },
    ];
  } catch (err) {
    logger.debug('StructuredData: weather fetch failed', { err });
    return [];
  }
}

/** FRED (Federal Reserve Economic Data) — free macro data */
async function fetchFinanceData(question: string): Promise<StructuredDataPoint[]> {
  const FRED_KEY = process.env['FRED_API_KEY'] ?? '';
  const lq = question.toLowerCase();

  // Determine which indicator to fetch based on question content
  const indicators: Array<{ keywords: string[]; seriesId: string; label: string }> = [
    { keywords: ['fed', 'federal reserve', 'rate', 'interest rate', 'hike', 'cut'], seriesId: 'FEDFUNDS', label: 'Fed Funds Rate' },
    { keywords: ['inflation', 'cpi', 'price'], seriesId: 'CPIAUCSL', label: 'CPI (inflation)' },
    { keywords: ['unemployment', 'jobs', 'payroll', 'nonfarm'], seriesId: 'UNRATE', label: 'Unemployment rate' },
    { keywords: ['gdp', 'growth', 'recession'], seriesId: 'GDP', label: 'GDP' },
  ];

  const matched = indicators.find((i) => i.keywords.some((k) => lq.includes(k)));
  if (!matched) return [];

  if (!FRED_KEY) {
    // No key — return contextual hint without data
    return [{ label: `Tip: Add FRED_API_KEY to .env for live ${matched.label} data`, value: '', relevance: 'low' }];
  }

  try {
    const { data } = await axios.get('https://api.stlouisfed.org/fred/series/observations', {
      params: { series_id: matched.seriesId, api_key: FRED_KEY, file_type: 'json', limit: 1, sort_order: 'desc' },
      timeout: 5000,
    });
    const obs = data.observations?.[0];
    return obs
      ? [{ label: matched.label, value: obs.value, relevance: 'high' }]
      : [];
  } catch (err) {
    logger.debug('StructuredData: FRED fetch failed', { err });
    return [];
  }
}

/** Dispatch to the right source based on market category */
export async function fetchStructuredData(
  question: string,
  category: string
): Promise<StructuredDataPoint[]> {
  const fetchers: Record<string, () => Promise<StructuredDataPoint[]>> = {
    crypto:   () => fetchCryptoData(question),
    finance:  () => fetchFinanceData(question),
    weather:  () => fetchWeatherData(question),
    politics: () => fetchFinanceData(question), // macro context helps for political markets too
  };

  const fetcher = fetchers[category];
  if (!fetcher) return [];

  try {
    return await fetcher();
  } catch {
    return [];
  }
}

/** Format structured data points into a summary string for Claude */
export function formatStructuredData(points: StructuredDataPoint[]): string {
  if (points.length === 0) return '';
  const lines = points
    .filter((p) => p.value)
    .map((p) => `• ${p.label}: ${p.value}`);
  return lines.length > 0 ? `\nStructured Data:\n${lines.join('\n')}` : '';
}
