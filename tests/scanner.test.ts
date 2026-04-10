import { MarketScanner } from '../src/scanner/index';
import { PolymarketClient } from '../src/scanner/polymarket';
import { KalshiClient } from '../src/scanner/kalshi';
import { Market } from '../src/shared/types';

jest.mock('../src/scanner/polymarket');
jest.mock('../src/scanner/kalshi');
jest.mock('../src/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockMarket = (overrides: Partial<Market> = {}): Market => ({
  id: 'test-market-1',
  platform: 'polymarket',
  question: 'Will it rain tomorrow?',
  description: 'Test market',
  yesPrice: 0.55,
  noPrice: 0.48,
  volume24h: 500,
  totalLiquidity: 2000,
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  createdAt: new Date(),
  category: 'weather',
  tags: ['weather'],
  ...overrides,
});

describe('MarketScanner', () => {
  let scanner: MarketScanner;
  let mockPoly: jest.Mocked<PolymarketClient>;
  let mockKalshi: jest.Mocked<KalshiClient>;

  beforeEach(() => {
    (PolymarketClient as jest.MockedClass<typeof PolymarketClient>).mockClear();
    (KalshiClient as jest.MockedClass<typeof KalshiClient>).mockClear();

    scanner = new MarketScanner(
      'http://poly.test',
      'http://kalshi.test',
      'test@test.com',
      '',
      { minLiquidity: 500 } // explicit filter so illiquid markets are filtered out
    );

    mockPoly = (PolymarketClient as jest.MockedClass<typeof PolymarketClient>)
      .mock.instances[0] as jest.Mocked<PolymarketClient>;
    mockKalshi = (KalshiClient as jest.MockedClass<typeof KalshiClient>)
      .mock.instances[0] as jest.Mocked<KalshiClient>;
  });

  describe('scan()', () => {
    it('fetches markets from both platforms and filters them', async () => {
      const validMarket = mockMarket();
      const illiquidMarket = mockMarket({ id: 'illiquid', totalLiquidity: 10 });

      mockPoly.fetchActiveMarkets = jest.fn().mockResolvedValue([validMarket]);
      mockKalshi.fetchActiveMarkets = jest.fn().mockResolvedValue([illiquidMarket]);
      mockPoly.fetchOrderBook = jest
        .fn()
        .mockResolvedValue({ marketId: 'test-market-1', bids: [], asks: [], timestamp: new Date() });

      const signals = await scanner.scan();

      expect(mockPoly.fetchActiveMarkets).toHaveBeenCalledWith(200);
      expect(mockKalshi.fetchActiveMarkets).toHaveBeenCalledWith(200);
      // illiquidMarket should be filtered out
      expect(signals.length).toBe(1);
      expect(signals[0]!.market.id).toBe('test-market-1');
    });

    it('returns empty array when both APIs fail', async () => {
      mockPoly.fetchActiveMarkets = jest.fn().mockResolvedValue([]);
      mockKalshi.fetchActiveMarkets = jest.fn().mockResolvedValue([]);

      const signals = await scanner.scan();
      expect(signals).toEqual([]);
    });
  });
});
