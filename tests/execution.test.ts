import { ExecutionEngine } from '../src/execution/index';
import { PolymarketExecutor } from '../src/execution/polymarket-executor';
import { KalshiExecutor } from '../src/execution/kalshi-executor';
import { PredictionResult, RiskAssessment } from '../src/shared/types';
import fs from 'fs';

jest.mock('../src/execution/polymarket-executor');
jest.mock('../src/execution/kalshi-executor');
jest.mock('../src/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('fs');

const mockPrediction: PredictionResult = {
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
};

const approvedRisk: RiskAssessment = {
  marketId: 'test-001',
  approved: true,
  rejectionReasons: [],
  positionSize: 250,
  kellyFraction: 0.025,
  maxExposure: 5000,
  valueAtRisk: 120,
  checks: [],
};

describe('ExecutionEngine', () => {
  let engine: ExecutionEngine;
  let mockPoly: jest.Mocked<PolymarketExecutor>;
  let mockKalshi: jest.Mocked<KalshiExecutor>;

  beforeEach(() => {
    (PolymarketExecutor as jest.MockedClass<typeof PolymarketExecutor>).mockClear();
    (KalshiExecutor as jest.MockedClass<typeof KalshiExecutor>).mockClear();
    (fs.existsSync as jest.Mock).mockReturnValue(false); // kill switch off

    engine = new ExecutionEngine('0x' + 'a'.repeat(64), 'test-api-key', 'test-secret', 'test-passphrase', 'test@test.com', 'pass');
    mockPoly = (PolymarketExecutor as jest.MockedClass<typeof PolymarketExecutor>)
      .mock.instances[0] as jest.Mocked<PolymarketExecutor>;
    mockKalshi = (KalshiExecutor as jest.MockedClass<typeof KalshiExecutor>)
      .mock.instances[0] as jest.Mocked<KalshiExecutor>;
  });

  it('executes trade on Polymarket when approved', async () => {
    mockPoly.placeOrder = jest.fn().mockResolvedValue({
      success: true,
      orderId: 'order-001',
      filledSize: 250,
      filledPrice: 0.45,
      slippage: 0.001,
      fees: 0,
    });

    const result = await engine.execute(mockPrediction, approvedRisk, 'polymarket');

    expect(result).not.toBeNull();
    expect(result?.status).toBe('filled');
    expect(result?.orderId).toBe('order-001');
  });

  it('returns null when kill switch is active', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true); // STOP file exists

    const result = await engine.execute(mockPrediction, approvedRisk, 'polymarket');
    expect(result).toBeNull();
    expect(mockPoly.placeOrder).not.toHaveBeenCalled();
  });

  it('returns null when risk assessment is not approved', async () => {
    const rejectedRisk: RiskAssessment = {
      ...approvedRisk,
      approved: false,
      rejectionReasons: ['Edge too small'],
    };

    const result = await engine.execute(mockPrediction, rejectedRisk, 'polymarket');
    expect(result).toBeNull();
  });

  it('returns null when prediction direction is pass', async () => {
    const passPrediction: PredictionResult = { ...mockPrediction, direction: 'pass' };
    const result = await engine.execute(passPrediction, approvedRisk, 'polymarket');
    expect(result).toBeNull();
  });
});
