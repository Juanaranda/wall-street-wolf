import { MarketSignal, ResearchBrief, SourceItem } from '../shared/types';
import { logger } from '../shared/logger';
import { ContentScraper } from './scraper';
import { SentimentAnalyzer } from './sentiment';
import { buildSearchQuery, getSubreddit } from './query-builder';
import { fetchStructuredData, formatStructuredData } from './structured-data';
import { SourceAnalysis } from './types';

export class ResearchAgent {
  private readonly scraper: ContentScraper;
  private readonly sentiment: SentimentAnalyzer;
  private readonly lessonsProvider?: (question: string) => string[];
  // Cache keyed by search query — cleared each scan cycle via clearCache()
  private readonly cache: Map<string, ResearchBrief> = new Map();

  constructor(newsApiKey: string = '', lessonsProvider?: (question: string) => string[]) {
    this.scraper = new ContentScraper(newsApiKey);
    this.sentiment = new SentimentAnalyzer();
    this.lessonsProvider = lessonsProvider;
  }

  /** Clear the per-cycle cache — call at the start of each scan cycle */
  clearCache(): void {
    this.cache.clear();
  }

  /** Run full research pipeline for a market signal */
  async research(signal: MarketSignal): Promise<ResearchBrief> {
    const { market } = signal;
    const category = market.category ?? 'general';

    // Build query first so we can check cache before doing any API calls
    const searchQuery = buildSearchQuery(market.question, category);
    const cacheKey = `${category}:${searchQuery}`;

    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      logger.debug(`ResearchAgent: cache hit for "${searchQuery}" — reusing results for ${market.id}`);
      // Return a copy with the correct marketId and current price
      return { ...cached, marketId: market.id, currentMarketPrice: market.yesPrice };
    }

    logger.info(`ResearchAgent: researching market ${market.id}`, {
      question: market.question,
      category,
    });
    const subreddit = getSubreddit(category);

    // Stocktwits symbol extraction for finance/crypto markets
    const stocktwitsSymbol = this.extractStocktwitsSymbol(market.question, category);

    logger.debug(`ResearchAgent: query="${searchQuery}" subreddit="${subreddit}" stocktwits="${stocktwitsSymbol ?? 'n/a'}"`);

    // Run news + Reddit + Stocktwits + structured data in parallel
    const [newsItems, redditItems, stocktwitsItems, structuredPoints] = await Promise.all([
      this.scraper.scrapeNews(searchQuery, 8, category),
      this.scraper.scrapeReddit(searchQuery, subreddit),
      stocktwitsSymbol ? this.scraper.scrapeStocktwits(stocktwitsSymbol) : Promise.resolve([]),
      fetchStructuredData(market.question, category),
    ]);

    const allItems = [...newsItems, ...redditItems, ...stocktwitsItems];

    if (allItems.length === 0) {
      logger.warn(`ResearchAgent: no sources found for ${market.id}`);
      return this.emptyBrief(market.id, market.yesPrice);
    }

    // Analyze sentiment
    const analyses = this.sentiment.analyzeBatch(allItems);
    const { score, label, consensus } = this.sentiment.aggregateSentiment(analyses);

    // Convert to shared SourceItem[]
    const sources: SourceItem[] = analyses.map((a) => ({
      url: a.item.url,
      title: a.item.title,
      content: a.item.rawContent.substring(0, 500),
      sentiment: a.sentiment.score,
      credibilityScore: a.credibilityScore,
      publishedAt: a.item.publishedAt,
      sourcePlatform: a.item.sourcePlatform === 'reddit' ? 'reddit'
        : a.item.sourcePlatform === 'stocktwits' ? 'news'  // treat as news for downstream
        : 'news',
    }));

    // Estimated edge based on sentiment vs market price
    const sentimentImpliedP = this.sentimentToProb(score);
    const estimatedEdge = sentimentImpliedP - market.yesPrice;

    const structuredSummary = formatStructuredData(structuredPoints);
    const pastLessons = this.lessonsProvider ? this.lessonsProvider(market.question) : [];
    const summary = this.buildSummary(market.question, label, score, market.yesPrice, estimatedEdge, consensus, structuredSummary, pastLessons);

    logger.info(`ResearchAgent: found ${newsItems.length} news, ${redditItems.length} reddit, ${stocktwitsItems.length} stocktwits, ${structuredPoints.length} structured data points`);

    const brief: ResearchBrief = {
      marketId: market.id,
      sentiment: label,
      sentimentScore: score,
      sources,
      narrativeConsensus: consensus,
      currentMarketPrice: market.yesPrice,
      estimatedEdge,
      summary,
      timestamp: new Date(),
    };

    this.cache.set(cacheKey, brief);
    return brief;
  }

  /** Run research for multiple signals in parallel */
  async researchBatch(signals: MarketSignal[]): Promise<ResearchBrief[]> {
    const limit = 5; // max parallel research requests
    const results: ResearchBrief[] = [];

    for (let i = 0; i < signals.length; i += limit) {
      const batch = signals.slice(i, i + limit);
      const batchResults = await Promise.all(batch.map((s) => this.research(s)));
      results.push(...batchResults);
    }

    return results;
  }

  private sentimentToProb(sentimentScore: number): number {
    // Map sentiment [-1, 1] to probability [0.1, 0.9]
    return 0.5 + sentimentScore * 0.4;
  }


  private buildSummary(
    question: string,
    label: string,
    score: number,
    marketPrice: number,
    edge: number,
    consensus: string,
    structuredData: string = '',
    pastLessons: string[] = []
  ): string {
    const edgeStr = edge > 0 ? `+${(edge * 100).toFixed(1)}%` : `${(edge * 100).toFixed(1)}%`;
    const lessonsSection = pastLessons.length > 0
      ? ` PAST FAILURES ON SIMILAR MARKETS: ${pastLessons.map((l, i) => `(${i + 1}) ${l}`).join(' ')}`
      : '';
    return (
      `Market: "${question}". ` +
      `Sentiment: ${label} (score: ${score.toFixed(3)}). ` +
      `Source consensus: ${consensus} ` +
      `Market price: ${(marketPrice * 100).toFixed(1)}%. ` +
      `Estimated edge: ${edgeStr}.` +
      structuredData +
      lessonsSection
    );
  }

  /**
   * Extract a Stocktwits-compatible symbol from the market question.
   * Only for finance/crypto categories where Stocktwits has relevant data.
   */
  private extractStocktwitsSymbol(question: string, category: string): string | null {
    if (!['finance', 'crypto'].includes(category)) return null;

    const SYMBOL_MAP: Record<string, string> = {
      bitcoin: 'BTC.X', btc: 'BTC.X',
      ethereum: 'ETH.X', eth: 'ETH.X',
      solana: 'SOL.X', sol: 'SOL.X',
      xrp: 'XRP.X', ripple: 'XRP.X',
      dogecoin: 'DOGE.X', doge: 'DOGE.X',
      apple: 'AAPL', tesla: 'TSLA', nvidia: 'NVDA',
      microsoft: 'MSFT', amazon: 'AMZN', google: 'GOOGL',
      meta: 'META', netflix: 'NFLX', sp500: 'SPY',
      's&p': 'SPY', nasdaq: 'QQQ', 'dow jones': 'DIA',
    };

    const lq = question.toLowerCase();
    const match = Object.entries(SYMBOL_MAP).find(([k]) => lq.includes(k));
    return match?.[1] ?? null;
  }

  private emptyBrief(marketId: string, currentPrice: number): ResearchBrief {
    return {
      marketId,
      sentiment: 'neutral',
      sentimentScore: 0,
      sources: [],
      narrativeConsensus: 'No sources available.',
      currentMarketPrice: currentPrice,
      estimatedEdge: 0,
      summary: 'Insufficient data for research.',
      timestamp: new Date(),
    };
  }
}

export { ContentScraper, SentimentAnalyzer };
