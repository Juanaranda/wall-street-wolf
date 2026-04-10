import { PredictionEngine } from '../src/prediction/index';
import { CalibrationTracker } from '../src/prediction/calibration';
import { EnsembleForecaster } from '../src/prediction/ensemble';
import { ResearchBrief } from '../src/shared/types';

jest.mock('../src/prediction/ensemble');
jest.mock('../src/prediction/calibration');
jest.mock('../src/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockBrief: ResearchBrief = {
  marketId: 'market-001',
  sentiment: 'bullish',
  sentimentScore: 0.4,
  sources: [],
  narrativeConsensus: '6 bullish, 2 bearish out of 8 sources.',
  currentMarketPrice: 0.45,
  estimatedEdge: 0.12,
  summary: 'Will the Fed raise rates? Market at 45%. Sources lean bullish.',
  timestamp: new Date(),
};

describe('PredictionEngine', () => {
  let engine: PredictionEngine;
  let mockForecaster: jest.Mocked<EnsembleForecaster>;
  let mockCalibration: jest.Mocked<CalibrationTracker>;

  beforeEach(() => {
    (EnsembleForecaster as jest.MockedClass<typeof EnsembleForecaster>).mockClear();
    (CalibrationTracker as jest.MockedClass<typeof CalibrationTracker>).mockClear();

    engine = new PredictionEngine('sk-or-test-key');
    mockForecaster = (EnsembleForecaster as jest.MockedClass<typeof EnsembleForecaster>)
      .mock.instances[0] as jest.Mocked<EnsembleForecaster>;
    mockCalibration = (CalibrationTracker as jest.MockedClass<typeof CalibrationTracker>)
      .mock.instances[0] as jest.Mocked<CalibrationTracker>;
  });

  describe('predict()', () => {
    it('generates YES signal when edge > 0.04 and confidence >= 0.55', async () => {
      mockForecaster.queryAll = jest.fn().mockResolvedValue([
        { model: 'claude-forecaster', probability: 0.65, confidence: 0.8, reasoning: 'Strong yes', latencyMs: 500 },
      ]);

      const result = await engine.predict(mockBrief, 10);

      expect(result.direction).toBe('yes');
      // XGBoost(0.45,w=0.10) + claude-forecaster(0.65,w=0.25) → modelP ≈ 0.5929, edge ≈ 0.1429
      expect(result.edge).toBeCloseTo(0.1429, 3);
      expect(result.modelProbability).toBeCloseTo(0.5929, 3);
    });

    it('returns pass when edge is too small', async () => {
      mockForecaster.queryAll = jest.fn().mockResolvedValue([
        { model: 'claude-forecaster', probability: 0.46, confidence: 0.8, reasoning: 'Slightly above market', latencyMs: 300 },
      ]);

      const result = await engine.predict(mockBrief, 10);
      expect(result.direction).toBe('pass');
    });

    it('returns pass when confidence is too low', async () => {
      mockForecaster.queryAll = jest.fn().mockResolvedValue([
        { model: 'claude-forecaster', probability: 0.65, confidence: 0.3, reasoning: 'Uncertain', latencyMs: 300 },
      ]);

      const result = await engine.predict(mockBrief, 10);
      expect(result.direction).toBe('pass');
    });
  });

  describe('recordOutcome()', () => {
    it('calls calibration tracker', () => {
      mockCalibration.record = jest.fn().mockReturnValue({
        marketId: 'market-001',
        predictedProbability: 0.65,
        actualOutcome: true,
        brierScore: 0.1225,
        timestamp: new Date(),
      });
      mockCalibration.averageBrierScore = jest.fn().mockReturnValue(0.15);

      engine.recordOutcome('market-001', 0.65, true);
      expect(mockCalibration.record).toHaveBeenCalledWith('market-001', 0.65, true);
    });
  });
});
