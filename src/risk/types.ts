import { PortfolioState } from '../shared/types';

export interface KellyInput {
  winProbability: number;    // p — your model's probability
  netOdds: number;           // b — (1/price) - 1
  bankroll: number;          // total available bankroll
  kellyFraction: number;     // fractional Kelly multiplier (0.25)
  maxPositionPct: number;    // hard cap as pct of bankroll (0.05)
}

export interface KellyResult {
  fullKellyFraction: number;
  fractionalKellyFraction: number;
  recommendedSizeUsd: number;
  cappedByHardLimit: boolean;
}

export interface VaRInput {
  positionSize: number;
  winProbability: number;
  zScore95: number;           // 1.645 for 95% confidence
}

export interface RiskGuardState {
  portfolio: PortfolioState;
  dailyLossUsd: number;
  dailyApiCostUsd: number;
  tradesToday: number;
  lastResetDate: string;      // ISO date string YYYY-MM-DD
}

export interface GuardResult {
  passed: boolean;
  checkName: string;
  value: number;
  threshold: number;
  reason: string;
}
