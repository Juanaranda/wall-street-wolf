export interface ScrapedItem {
  url: string;
  title: string;
  rawContent: string;
  publishedAt: Date;
  sourcePlatform: 'reddit' | 'news' | 'stocktwits' | 'other';
  subreddit?: string;
  domainCredibility?: number; // pre-computed by scraper based on source domain
}

export interface SentimentResult {
  score: number;       // -1 (bearish) to +1 (bullish)
  label: 'bullish' | 'bearish' | 'neutral';
  confidence: number;  // 0–1
  keywords: string[];
}

export interface SourceAnalysis {
  item: ScrapedItem;
  sentiment: SentimentResult;
  credibilityScore: number;  // 0–1 based on source reliability
}

export interface NewsApiArticle {
  title: string;
  description: string | null;
  url: string;
  publishedAt: string;
  source: { name: string };
}

export interface RedditPost {
  title: string;
  selftext: string;
  url: string;
  created_utc: number;
  subreddit: string;
  score: number;
}
