import { XGBoostFastModel, XGBOOST_GATE_THRESHOLD } from '../src/prediction/fast-model';
import { ResearchBrief, MarketSignal, Market } from '../src/shared/types';
import { execFile } from 'child_process';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));
jest.mock('util', () => ({
  promisify: (fn: Function) => fn,
}));
jest.mock('../src/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockMarket: Market = {
  id: 'test-001',
  platform: 'polymarket',
  question: 'Will Fed raise rates?',
  description: '',
  yesPrice: 0.45,
  noPrice: 0.58,
  volume24h: 5000,
  totalLiquidity: 20000,
  expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  createdAt: new Date(),
  category: 'finance',
  tags: ['fed'],
};

const mockSignal: MarketSignal = {
  market: mockMarket,
  anomalyScore: 70,
  spreadWidth: 0.03,
  volumeSpike: 1.5,
  orderBookDepth: 5000,
  tradeable: true,
  reason: 'volume spike',
};

const mockBrief: ResearchBrief = {
  marketId: 'test-001',
  sentiment: 'bullish',
  sentimentScore: 0.4,
  sources: [{ url: 'x', title: 'y', content: 'z', sentiment: 0.4, credibilityScore: 0.8, publishedAt: new Date(), sourcePlatform: 'news' }],
  narrativeConsensus: '5 bullish sources',
  currentMarketPrice: 0.45,
  estimatedEdge: 0.12,
  summary: 'Market at 45%.',
  timestamp: new Date(),
};

describe('XGBoostFastModel', () => {
  let model: XGBoostFastModel;
  let mockExecFile: jest.Mock;

  beforeEach(() => {
    model = new XGBoostFastModel();
    mockExecFile = execFile as unknown as jest.Mock;
    mockExecFile.mockClear();
  });

  it('returns passesGate=true when |edge| >= threshold', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, JSON.stringify({ probability: 0.65, edge: 0.20, market_price: 0.45, used_fallback: false, has_model: true }), '');
    });

    const input = XGBoostFastModel.buildInput(mockBrief, mockSignal);
    const result = await model.predict(input);

    expect(result.probability).toBeCloseTo(0.65);
    expect(result.edge).toBeCloseTo(0.20);
    expect(result.passesGate).toBe(true);
    expect(result.usedFallback).toBe(false);
  });

  it('returns passesGate=false when |edge| < threshold', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, JSON.stringify({ probability: 0.46, edge: 0.01, market_price: 0.45, used_fallback: false, has_model: true }), '');
    });

    const input = XGBoostFastModel.buildInput(mockBrief, mockSignal);
    const result = await model.predict(input);

    expect(result.passesGate).toBe(false);
    expect(Math.abs(result.edge)).toBeLessThan(XGBOOST_GATE_THRESHOLD);
  });

  it('fails open (passesGate=true) when subprocess errors', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(new Error('Python not found'), '', '');
    });

    const input = XGBoostFastModel.buildInput(mockBrief, mockSignal);
    const result = await model.predict(input);

    expect(result.passesGate).toBe(true);  // fail-open
    expect(result.usedFallback).toBe(true);
    expect(result.probability).toBeCloseTo(0.45); // falls back to market price
  });

  describe('buildInput()', () => {
    it('correctly maps ResearchBrief + MarketSignal to FastModelInput', () => {
      const input = XGBoostFastModel.buildInput(mockBrief, mockSignal);

      expect(input.marketPrice).toBe(0.45);
      expect(input.sentimentScore).toBe(0.4);
      expect(input.estimatedEdge).toBe(0.12);
      expect(input.sourceCount).toBe(1);
      expect(input.anomalyScore).toBe(70);
      expect(input.volumeSpike).toBe(1.5);
      expect(input.category).toBe('finance');
    });
  });
});
