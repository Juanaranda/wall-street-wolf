import { RiskGuard } from '../src/risk/guards';
import { calculateKelly, netOddsFromPrice, calculateVaR } from '../src/risk/kelly';
import { PredictionResult } from '../src/shared/types';

jest.mock('../src/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockPrediction = (overrides: Partial<PredictionResult> = {}): PredictionResult => ({
  marketId: 'test-001',
  modelProbability: 0.70,
  marketProbability: 0.45,
  edge: 0.25,
  confidence: 0.80,
  direction: 'yes',
  modelVotes: [],
  mispricingScore: 1.67,
  expectedValue: 0.27,
  timestamp: new Date(),
  ...overrides,
});

const defaultConfig = {
  minEdge: 0.04,
  maxPositionSizeUsd: 500,
  maxTotalExposureUsd: 5000,
  maxDailyLossUsd: 750,
  maxDrawdownPct: 0.08,
  maxConcurrentPositions: 15,
  kellyFraction: 0.25,
  maxDailyApiCostUsd: 50,
};

describe('calculateKelly', () => {
  it('returns positive size for edge trade', () => {
    const result = calculateKelly({
      winProbability: 0.70,
      netOdds: 1.22,
      bankroll: 10000,
      kellyFraction: 0.25,
      maxPositionPct: 0.05,
    });
    expect(result.recommendedSizeUsd).toBeGreaterThan(0);
    expect(result.fullKellyFraction).toBeGreaterThan(0);
  });

  it('returns 0 for negative edge trade', () => {
    const result = calculateKelly({
      winProbability: 0.30,
      netOdds: 1.0,
      bankroll: 10000,
      kellyFraction: 0.25,
      maxPositionPct: 0.05,
    });
    expect(result.recommendedSizeUsd).toBe(0);
  });

  it('caps at maxPositionPct', () => {
    const result = calculateKelly({
      winProbability: 0.99,
      netOdds: 10,
      bankroll: 10000,
      kellyFraction: 1.0,
      maxPositionPct: 0.05,
    });
    expect(result.cappedByHardLimit).toBe(true);
    expect(result.recommendedSizeUsd).toBeLessThanOrEqual(500);
  });
});

describe('RiskGuard', () => {
  let guard: RiskGuard;

  beforeEach(() => {
    guard = new RiskGuard(10000, defaultConfig);
  });

  it('approves a valid trade', () => {
    const assessment = guard.assess(mockPrediction());
    expect(assessment.approved).toBe(true);
    expect(assessment.positionSize).toBeGreaterThan(0);
  });

  it('rejects when edge is too small', () => {
    const prediction = mockPrediction({ edge: 0.02 });
    const assessment = guard.assess(prediction);
    expect(assessment.approved).toBe(false);
    expect(assessment.rejectionReasons.some((r) => r.includes('Edge'))).toBe(true);
  });

  it('rejects when daily loss exceeds limit', () => {
    // Simulate losses
    guard.recordSettlement(-800);
    const assessment = guard.assess(mockPrediction());
    expect(assessment.approved).toBe(false);
    expect(assessment.rejectionReasons.some((r) => r.includes('Daily loss'))).toBe(true);
  });

  it('rejects when drawdown exceeds limit', () => {
    guard.recordSettlement(-900); // 9% drawdown on 10k bankroll
    const assessment = guard.assess(mockPrediction());
    expect(assessment.approved).toBe(false);
  });
});
