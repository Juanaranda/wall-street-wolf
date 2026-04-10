import { v4 as uuidv4 } from 'uuid';

/** Generate a unique trade ID */
export function generateTradeId(): string {
  return `trade_${uuidv4()}`;
}

/** Clamp a number to [min, max] */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Round to N decimal places */
export function round(value: number, decimals: number = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Calculate Brier Score for a single prediction.
 * BS = (predicted - outcome)^2  — lower is better
 */
export function brierScore(predicted: number, outcome: boolean): number {
  return Math.pow(predicted - (outcome ? 1 : 0), 2);
}

/**
 * Calculate z-score mispricing: (modelP - marketP) / stdDev
 */
export function mispricingZScore(
  modelP: number,
  marketP: number,
  stdDev: number
): number {
  if (stdDev === 0) return 0;
  return (modelP - marketP) / stdDev;
}

/**
 * Calculate expected value.
 * EV = p * b - (1 - p)
 * where b = decimal odds - 1
 */
export function expectedValue(probability: number, decimalOdds: number): number {
  const b = decimalOdds - 1;
  return probability * b - (1 - probability);
}

/**
 * Calculate Kelly fraction.
 * f* = (p * b - q) / b
 */
export function kellyFraction(p: number, b: number): number {
  const q = 1 - p;
  return (p * b - q) / b;
}

/**
 * Calculate fractional Kelly position size in USD.
 */
export function kellyPositionSize(
  bankroll: number,
  p: number,
  b: number,
  fraction: number = 0.25
): number {
  const f = kellyFraction(p, b);
  if (f <= 0) return 0;
  return bankroll * Math.min(f * fraction, 0.05); // Hard cap 5% per trade
}

/** Weighted average of an array of [value, weight] pairs */
export function weightedAverage(pairs: Array<[number, number]>): number {
  const totalWeight = pairs.reduce((sum, [, w]) => sum + w, 0);
  if (totalWeight === 0) return 0;
  return pairs.reduce((sum, [v, w]) => sum + v * w, 0) / totalWeight;
}

/** Sleep for ms milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Format currency for display */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Check if the kill switch file exists */
import fs from 'fs';
export function isKillSwitchActive(): boolean {
  return fs.existsSync('./STOP');
}

/** Sanitize external content to prevent prompt injection */
export function sanitizeExternalContent(content: string): string {
  // Remove potential instruction injection patterns
  return content
    .replace(/\[INST\]|\[\/INST\]/g, '')
    .replace(/<\|im_start\|>|<\|im_end\|>/g, '')
    .replace(/###\s*(Instruction|System|Human|Assistant):/gi, '')
    .substring(0, 2000); // Truncate to reasonable length
}
