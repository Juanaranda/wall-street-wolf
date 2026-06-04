import fs from 'fs';
import path from 'path';
import { logger } from '../shared/logger';

/**
 * Simple, conservative long-only position sizing for Fintual (manual execution).
 *
 * Deliberately NOT Kelly/leverage — sober expectations: a small base allocation
 * scaled by signal confidence, hard-capped as a fraction of bankroll, floored at
 * a minimum order size (but the floor never exceeds the per-position cap, so it
 * works for small budgets too — e.g. a US$100 starting bankroll).
 */
export interface SizingConfig {
  bankrollUsd: number;
  /** Base allocation per trade as a fraction of bankroll (e.g. 0.05 = 5%). */
  basePct: number;
  /** Hard cap per position as a fraction of bankroll (e.g. 0.10 = 10%). */
  maxPct: number;
  /** Minimum order size in USD (Fintual allows fractional from ~US$1). */
  minUsd: number;
}

const CONFIG_PATH = process.env['TRADING_CONFIG'] ?? 'config/trading.json';

const FALLBACK: SizingConfig = { bankrollUsd: 10000, basePct: 0.05, maxPct: 0.1, minUsd: 1 };

function envNum(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function fileConfig(): Partial<SizingConfig> {
  try {
    const p = path.resolve(CONFIG_PATH);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<SizingConfig>;
  } catch (err) {
    logger.warn('equity-sizing: could not read trading config — using defaults', { err });
    return {};
  }
}

/**
 * Resolve sizing config. Precedence: **config/trading.json (your saved budget)**
 * › env vars › fallback. The JSON file wins on purpose so your saved budget always
 * takes effect (a stale INITIAL_BANKROLL in .env can't silently override it).
 * To change your budget, edit `config/trading.json` → `bankrollUsd`.
 */
export function loadSizingConfig(): SizingConfig {
  const f = fileConfig();
  return {
    bankrollUsd: f.bankrollUsd ?? envNum('INITIAL_BANKROLL') ?? FALLBACK.bankrollUsd,
    basePct: f.basePct ?? envNum('SIZING_BASE_PCT') ?? FALLBACK.basePct,
    maxPct: f.maxPct ?? envNum('SIZING_MAX_PCT') ?? FALLBACK.maxPct,
    minUsd: f.minUsd ?? envNum('MIN_ORDER_USD') ?? FALLBACK.minUsd,
  };
}

export const DEFAULT_SIZING: SizingConfig = loadSizingConfig();

/**
 * Suggested USD amount for a trade given the signal confidence (0–1).
 * Confidence 0→base×0.5, 1→base; capped at maxPct of bankroll; floored at minUsd
 * — but the floor is itself capped at maxPct of bankroll so a small bankroll can
 * never produce an order bigger than its per-position cap.
 */
export function sizePosition(confidence: number, cfg: SizingConfig = DEFAULT_SIZING): number {
  const c = Math.max(0, Math.min(1, confidence));
  const scale = 0.5 + 0.5 * c; // 0.5 … 1.0
  const maxUsd = cfg.bankrollUsd * cfg.maxPct;
  const target = cfg.bankrollUsd * cfg.basePct * scale;
  const floor = Math.min(cfg.minUsd, maxUsd); // floor can't exceed the cap
  const usd = Math.min(maxUsd, Math.max(floor, target));
  return Math.round(usd * 100) / 100; // 2 decimals — Fintual supports fractional
}
