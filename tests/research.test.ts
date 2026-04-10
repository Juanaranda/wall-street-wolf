import { ResearchAgent } from '../src/research/index';
import { SentimentAnalyzer } from '../src/research/sentiment';
import { ContentScraper } from '../src/research/scraper';
import { MarketSignal, Market } from '../src/shared/types';

jest.mock('../src/research/scraper');
jest.mock('../src/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../src/research/structured-data', () => ({
  fetchStructuredData: jest.fn().mockResolvedValue([]),
  formatStructuredData: jest.fn().mockReturnValue(''),
}));

const mockMarket: Market = {
  id: 'test-001',
  platform: 'polymarket',
  question: 'Will the Fed raise rates in March?',
  description: 'Federal Reserve rate decision',
  yesPrice: 0.42,
  noPrice: 0.61,
  volume24h: 5000,
  totalLiquidity: 20000,
  expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  createdAt: new Date(),
  category: 'finance',
  tags: ['fed', 'rates'],
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

describe('SentimentAnalyzer', () => {
  const analyzer = new SentimentAnalyzer();

  it('detects bullish sentiment', () => {
    const result = analyzer.analyze('The market is rallying with huge gains today');
    expect(result.label).toBe('bullish');
    expect(result.score).toBeGreaterThan(0);
  });

  it('detects bearish sentiment', () => {
    const result = analyzer.analyze('Markets crash as rates rise sharply, decline expected');
    expect(result.label).toBe('bearish');
    expect(result.score).toBeLessThan(0);
  });

  it('returns neutral for empty text', () => {
    const result = analyzer.analyze('');
    expect(result.label).toBe('neutral');
    expect(result.score).toBe(0);
  });
});

describe('ResearchAgent', () => {
  let agent: ResearchAgent;
  let mockScraper: jest.Mocked<ContentScraper>;

  beforeEach(() => {
    (ContentScraper as jest.MockedClass<typeof ContentScraper>).mockClear();
    agent = new ResearchAgent('test-api-key');
    mockScraper = (ContentScraper as jest.MockedClass<typeof ContentScraper>)
      .mock.instances[0] as jest.Mocked<ContentScraper>;
  });

  it('returns empty brief when no sources found', async () => {
    mockScraper.scrapeNews = jest.fn().mockResolvedValue([]);
    mockScraper.scrapeReddit = jest.fn().mockResolvedValue([]);

    const brief = await agent.research(mockSignal);

    expect(brief.marketId).toBe('test-001');
    expect(brief.sources).toHaveLength(0);
    expect(brief.sentiment).toBe('neutral');
  });

  it('aggregates sources when available', async () => {
    const newsItem = {
      url: 'https://reuters.com/test',
      title: 'Fed likely to hold rates steady',
      rawContent: 'Analysis shows the Federal Reserve will hold rates',
      publishedAt: new Date(),
      sourcePlatform: 'news' as const,
    };
    mockScraper.scrapeNews = jest.fn().mockResolvedValue([newsItem]);
    mockScraper.scrapeReddit = jest.fn().mockResolvedValue([]);

    const brief = await agent.research(mockSignal);

    expect(brief.sources.length).toBeGreaterThan(0);
    expect(brief.summary).toContain('Will the Fed raise rates');
  });
});
