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
  // Detect environment: use _DEV suffix when pointing at demo endpoint
  const env = process.env['NODE_ENV'] === 'production' ? 'PROD' : 'DEV';

  // Helper: try suffixed key first, fall back to unsuffixed
  const envWithFallback = (base: string, defaultVal?: string): string => {
    const suffixed = process.env[`${base}_${env}`];
    if (suffixed) return suffixed;
    const plain = process.env[base];
    if (plain) return plain;
    if (defaultVal !== undefined) return defaultVal;
    throw new Error(`Missing required environment variable: ${base}_${env} or ${base}`);
  };

  return {
    polymarket: {
      apiUrl: optionalEnv('POLYMARKET_API_URL', 'https://clob.polymarket.com'),
      wsUrl: optionalEnv(
        'POLYMARKET_WS_URL',
        'wss://ws-subscriptions-clob.polymarket.com/ws/market'
      ),
      privateKey: envWithFallback('POLYMARKET_PRIVATE_KEY'),
      apiKey: envWithFallback('POLYMARKET_API_KEY', ''),
      secret: envWithFallback('POLYMARKET_SECRET', ''),
      passphrase: envWithFallback('POLYMARKET_PASSPHRASE', ''),
    },
    kalshi: {
      apiUrl: envWithFallback('KALSHI_API_URL', 'https://demo-api.kalshi.co/trade-api/v2'),
      apiKeyId: envWithFallback('KALSHI_API_KEY_ID'),
      privateKey: envWithFallback('KALSHI_PRIVATE_KEY'),
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
    binance: {
      apiUrl: envWithFallback('BINANCE_API_URL', 'https://testnet.binance.vision/api'),
      apiKey: envWithFallback('BINANCE_API_KEY', ''),
      apiSecret: envWithFallback('BINANCE_API_SECRET', ''),
      testnet: process.env['BINANCE_TESTNET'] !== 'false',
    },
    alpaca: {
      apiKey: envWithFallback('ALPACA_API_KEY', ''),
      apiSecret: envWithFallback('ALPACA_API_SECRET', ''),
      paperTrading: process.env['ALPACA_PAPER'] !== 'false',
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
