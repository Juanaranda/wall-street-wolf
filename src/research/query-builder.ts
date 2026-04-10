/**
 * Builds smart, focused search queries from raw market questions.
 * Strips boilerplate ("Will", "How many", "Does") and extracts key entities.
 */

const STOPWORDS = new Set([
  'will', 'would', 'could', 'should', 'does', 'did', 'has', 'have', 'had',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'up', 'about', 'into', 'through',
  'how', 'many', 'much', 'more', 'than', 'least', 'most',
  'this', 'that', 'these', 'those', 'it', 'its', 'their',
  'today', 'tonight', 'game', 'match', 'event', 'during', 'before',
  'hit', 'score', 'make', 'get', 'go', 'end', 'close', 'finish', 'reach',
  'least', 'exactly', 'any', 'single', 'singles', 'double', 'triple',
]);

/** Extract the most meaningful search terms from a market question */
export function buildSearchQuery(question: string, category: string): string {
  // Remove punctuation, split, filter stopwords
  const words = question
    .replace(/[^a-zA-Z0-9\s$%+\-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()));

  // Keep meaningful tokens (capitalized = likely entity)
  const entities = words.filter((w) => /^[A-Z]/.test(w));
  const keyTerms = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));

  // Prioritize entities + category context
  const base = entities.length >= 2
    ? entities.slice(0, 4).join(' ')
    : keyTerms.slice(0, 5).join(' ');

  const categoryContext: Record<string, string> = {
    politics: 'politics election',
    finance: 'economy market',
    crypto: 'cryptocurrency',
    sports: 'game stats',
    science: 'research study',
    weather: 'forecast',
  };

  const ctx = categoryContext[category] ?? '';
  const query = `${base} ${ctx}`.trim();

  return query.substring(0, 100);
}

/** Category-specific Reddit subreddits */
export const CATEGORY_SUBREDDITS: Record<string, string> = {
  politics: 'politics+PoliticalDiscussion+worldnews',
  finance: 'economics+investing+wallstreetbets+stocks',
  crypto: 'CryptoCurrency+bitcoin+ethereum+CryptoMarkets',
  sports: 'sports+baseball+nfl+nba+soccer',
  science: 'science+technology',
  weather: 'weather',
  general: 'news+worldnews',
};

export function getSubreddit(category: string): string {
  return CATEGORY_SUBREDDITS[category] ?? CATEGORY_SUBREDDITS['general']!;
}
