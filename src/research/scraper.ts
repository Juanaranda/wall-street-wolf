import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../shared/logger';
import { sanitizeExternalContent } from '../shared/utils';
import { ScrapedItem, NewsApiArticle, RedditPost } from './types';

const CREDIBLE_DOMAINS = new Set([
  'reuters.com', 'apnews.com', 'bbc.com', 'nytimes.com',
  'wsj.com', 'ft.com', 'bloomberg.com', 'politico.com',
  'cnbc.com', 'thehill.com', 'axios.com', 'theguardian.com',
  'espn.com', 'cbssports.com', 'coindesk.com', 'cointelegraph.com',
  'fivethirtyeight.com', 'predictit.org',
]);

// Category-specific trusted News API sources (boosts relevance)
const CATEGORY_SOURCES: Record<string, string> = {
  finance:  'reuters,bloomberg,cnbc,wsj,ft,the-wall-street-journal',
  crypto:   'coindesk,crypto-coins-news,cointelegraph',
  politics: 'reuters,ap,bbc-news,politico,the-hill,axios',
  sports:   'espn,bleacher-report,cbs-sports,fox-sports',
  science:  'new-scientist,wired,ars-technica,techcrunch',
  general:  'reuters,bbc-news,ap,associated-press',
};

export class ContentScraper {
  private readonly newsApiKey: string;

  constructor(newsApiKey: string = '') {
    this.newsApiKey = newsApiKey;
  }

  /** Scrape news articles — uses focused query + category-specific sources */
  async scrapeNews(query: string, limit: number = 10, category: string = 'general'): Promise<ScrapedItem[]> {
    if (!this.newsApiKey) {
      logger.warn('ContentScraper: no NEWS_API_KEY set, skipping news scrape');
      return [];
    }

    const sources = CATEGORY_SOURCES[category] ?? CATEGORY_SOURCES['general'];

    try {
      const response = await axios.get<{ articles: NewsApiArticle[]; totalResults: number }>(
        'https://newsapi.org/v2/everything',
        {
          params: {
            q: query,
            sources,
            sortBy: 'relevancy',
            pageSize: limit,
            language: 'en',
            from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // last 7 days
          },
          headers: { 'X-Api-Key': this.newsApiKey },
          timeout: 8000,
        }
      );

      logger.debug(`ContentScraper: NewsAPI returned ${response.data.totalResults} results for "${query}"`);

      // If category sources return nothing, retry with broader search
      if (response.data.articles.length === 0) {
        return await this.scrapeNewsGeneral(query, limit);
      }

      return response.data.articles.map((a) => ({
        url: a.url,
        title: sanitizeExternalContent(a.title),
        rawContent: sanitizeExternalContent(a.description ?? ''),
        publishedAt: new Date(a.publishedAt),
        sourcePlatform: 'news' as const,
        domainCredibility: this.creditabilityScore(a.url),
      }));
    } catch (err) {
      logger.warn('ContentScraper.scrapeNews failed', { query, err });
      return [];
    }
  }

  /** Broader news search without source filter — fallback */
  private async scrapeNewsGeneral(query: string, limit: number): Promise<ScrapedItem[]> {
    try {
      const response = await axios.get<{ articles: NewsApiArticle[] }>(
        'https://newsapi.org/v2/everything',
        {
          params: { q: query, sortBy: 'relevancy', pageSize: limit, language: 'en' },
          headers: { 'X-Api-Key': this.newsApiKey },
          timeout: 8000,
        }
      );
      return response.data.articles.map((a) => ({
        url: a.url,
        title: sanitizeExternalContent(a.title),
        rawContent: sanitizeExternalContent(a.description ?? ''),
        publishedAt: new Date(a.publishedAt),
        sourcePlatform: 'news' as const,
        domainCredibility: this.creditabilityScore(a.url),
      }));
    } catch {
      return [];
    }
  }

  /** Scrape Reddit posts — uses category-specific subreddits */
  async scrapeReddit(query: string, subreddit: string = 'all'): Promise<ScrapedItem[]> {
    try {
      const searchUrl = `https://www.reddit.com/r/${subreddit}/search.json`;
      const response = await axios.get<{
        data: { children: Array<{ data: RedditPost }> };
      }>(searchUrl, {
        params: { q: query.substring(0, 100), sort: 'relevance', limit: 8, t: 'week' },
        headers: { 'User-Agent': 'WallStreetWolf/1.0 (prediction-market-bot)' },
        timeout: 8000,
      });

      return response.data.data.children.map(({ data: post }) => ({
        url: `https://reddit.com${post.url}`,
        title: sanitizeExternalContent(post.title),
        rawContent: sanitizeExternalContent(post.selftext ?? ''),
        publishedAt: new Date(post.created_utc * 1000),
        sourcePlatform: 'reddit' as const,
        subreddit: post.subreddit,
        domainCredibility: 0.5,
      }));
    } catch (err) {
      logger.warn('ContentScraper.scrapeReddit failed', { query, err });
      return [];
    }
  }

  /**
   * Scrape Stocktwits for finance/crypto market sentiment — free, no API key needed.
   * Stocktwits is purpose-built for financial sentiment; better signal than Twitter for these markets.
   */
  async scrapeStocktwits(symbol: string): Promise<ScrapedItem[]> {
    try {
      const response = await axios.get<{
        messages: Array<{ body: string; created_at: string; id: number }>;
      }>(
        `https://api.stocktwits.com/api/2/streams/symbol/${symbol}.json`,
        { timeout: 6000 }
      );

      return response.data.messages.slice(0, 10).map((msg) => ({
        url: `https://stocktwits.com/symbol/${symbol}`,
        title: sanitizeExternalContent(msg.body.substring(0, 120)),
        rawContent: sanitizeExternalContent(msg.body),
        publishedAt: new Date(msg.created_at),
        sourcePlatform: 'stocktwits' as const,
        domainCredibility: 0.6,
      }));
    } catch (err) {
      logger.debug('ContentScraper.scrapeStocktwits failed', { symbol, err });
      return [];
    }
  }

  /** Assign credibility score based on source domain */
  creditabilityScore(url: string): number {
    try {
      const hostname = new URL(url).hostname.replace('www.', '');
      if (CREDIBLE_DOMAINS.has(hostname)) return 0.9;
      if (hostname.includes('.gov') || hostname.includes('.edu')) return 0.85;
      if (hostname.endsWith('.reddit.com')) return 0.5;
      return 0.4;
    } catch {
      return 0.3;
    }
  }

  /** Extract main text from an HTML page (best-effort) */
  async fetchPageText(url: string): Promise<string> {
    try {
      const response = await axios.get<string>(url, {
        timeout: 5000,
        headers: { 'User-Agent': 'WallStreetWolf/1.0' },
        maxContentLength: 50_000,
      });
      const $ = cheerio.load(response.data as string);
      $('script, style, nav, footer, header').remove();
      return sanitizeExternalContent($('body').text().replace(/\s+/g, ' ').trim());
    } catch {
      return '';
    }
  }
}
