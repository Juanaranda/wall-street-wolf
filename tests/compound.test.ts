import { CompoundService } from '../src/compound/index';
import { TradeLogger } from '../src/compound/trade-logger';
import { PerformanceAnalyzer } from '../src/compound/analyzer';
import { TradeResult, PredictionResult } from '../src/shared/types';

jest.mock('../src/compound/trade-logger');
jest.mock('../src/compound/analyzer');
jest.mock('../src/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockTradeResult: TradeResult = {
  orderId: 'order-001',
  marketId: 'market-001',
  platform: 'polymarket',
  direction: 'yes',
  filledSize: 250,
  filledPrice: 0.45,
  slippage: 0.001,
  fees: 0,
  status: 'filled',
  timestamp: new Date(),
};

const mockPrediction: PredictionResult = {
  marketId: 'market-001',
  modelProbability: 0.70,
  marketProbability: 0.45,
  edge: 0.25,
  confidence: 0.80,
  direction: 'yes',
  modelVotes: [],
  mispricingScore: 1.67,
  expectedValue: 0.27,
  timestamp: new Date(),
};

describe('CompoundService', () => {
  let service: CompoundService;
  let mockLogger: jest.Mocked<TradeLogger>;
  let mockAnalyzer: jest.Mocked<PerformanceAnalyzer>;

  beforeEach(() => {
    (TradeLogger as jest.MockedClass<typeof TradeLogger>).mockClear();
    (PerformanceAnalyzer as jest.MockedClass<typeof PerformanceAnalyzer>).mockClear();
    service = new CompoundService('./data/test-trades.jsonl');
    mockLogger = (TradeLogger as jest.MockedClass<typeof TradeLogger>)
      .mock.instances[0] as jest.Mocked<TradeLogger>;
    mockAnalyzer = (PerformanceAnalyzer as jest.MockedClass<typeof PerformanceAnalyzer>)
      .mock.instances[0] as jest.Mocked<PerformanceAnalyzer>;
  });

  describe('recordExecution()', () => {
    it('creates and saves a trade record', () => {
      mockLogger.append = jest.fn();
      const record = service.recordExecution(mockTradeResult, mockPrediction, 'Will Bitcoin hit $100k?');
      expect(mockLogger.append).toHaveBeenCalledTimes(1);
      expect(record.marketId).toBe('market-001');
      expect(record.predictedProbability).toBe(0.70);
      expect(record.direction).toBe('yes');
    });
  });

  describe('recordSettlement()', () => {
    it('updates the trade with outcome and calculates Brier Score', () => {
      mockLogger.getAll = jest.fn().mockReturnValue([{
        tradeId: 'order-001',
        marketId: 'market-001',
        predictedProbability: 0.70,
        marketProbabilityAtEntry: 0.45,
        direction: 'yes',
        question: 'Test?',
        platform: 'polymarket',
        entryPrice: 0.45,
        size: 250,
        openedAt: new Date(),
      }]);
      mockLogger.update = jest.fn();
      mockAnalyzer.classifyFailure = jest.fn().mockReturnValue({
        id: 'l1', marketId: 'm1', question: 'Test?',
        failureCategory: 'bad_prediction', lesson: 'Lesson',
        marketPrice: 0.45, predictedProbability: 0.70, pnl: -50, timestamp: new Date(),
      });

      service.recordSettlement('order-001', false, 0.1, -50);

      expect(mockLogger.update).toHaveBeenCalledWith('order-001', expect.objectContaining({
        outcome: false,
        pnl: -50,
        brierScore: expect.any(Number),
      }));
    });
  });
});
