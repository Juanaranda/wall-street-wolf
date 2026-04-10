import dotenv from 'dotenv';
import { BotConfig } from './types';

dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optionalEnv(key: string, defaultVal: string): string {
  return process.env[key] ?? defaultVal;
}

export function loadConfig(): BotConfig {
  return {
    polymarket: {
      apiUrl: optionalEnv('POLYMARKET_API_URL', 'https://clob.polymarket.com'),
      wsUrl: optionalEnv(
        'POLYMARKET_WS_URL',
        'wss://ws-subscriptions-clob.polymarket.com/ws/market'
      ),
      privateKey: requireEnv('POLYMARKET_PRIVATE_KEY'),
      apiKey: optionalEnv('POLYMARKET_API_KEY', ''),
      secret: optionalEnv('POLYMARKET_SECRET', ''),
      passphrase: optionalEnv('POLYMARKET_PASSPHRASE', ''),
    },
    kalshi: {
      apiUrl: optionalEnv('KALSHI_API_URL', 'https://demo-api.kalshi.co/trade-api/v2'),
      apiKeyId: requireEnv('KALSHI_API_KEY_ID'),
      privateKey: requireEnv('KALSHI_PRIVATE_KEY'),
    },
    trading: {
      minEdge: parseFloat(optionalEnv('MIN_EDGE', '0.04')),
      minLiquidity: parseInt(optionalEnv('MIN_LIQUIDITY', '200'), 10),
      maxPositionSizeUsd: parseFloat(optionalEnv('MAX_POSITION_SIZE_USD', '500')),
      maxTotalExposureUsd: parseFloat(optionalEnv('MAX_TOTAL_EXPOSURE_USD', '5000')),
      maxDailyLossUsd: parseFloat(optionalEnv('MAX_DAILY_LOSS_USD', '750')),
      maxDrawdownPct: parseFloat(optionalEnv('MAX_DRAWDOWN_PCT', '0.08')),
      maxConcurrentPositions: parseInt(optionalEnv('MAX_CONCURRENT_POSITIONS', '15'), 10),
      kellyFraction: parseFloat(optionalEnv('KELLY_FRACTION', '0.25')),
      scanIntervalMs: parseInt(optionalEnv('SCAN_INTERVAL_MS', '900000'), 10),
      maxDailyApiCostUsd: parseFloat(optionalEnv('MAX_DAILY_API_COST_USD', '50')),
    },
    ai: {
      openRouterApiKey: requireEnv('OPENROUTER_API_KEY'),
    },
    logging: {
      level: optionalEnv('LOG_LEVEL', 'info'),
      tradeLogPath: optionalEnv('TRADE_LOG_PATH', './data/trades.jsonl'),
      failureLogPath: optionalEnv('FAILURE_LOG_PATH', './data/failures.jsonl'),
    },
  };
}
