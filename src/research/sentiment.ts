import Sentiment from 'sentiment';
import { logger } from '../shared/logger';
import { ScrapedItem, SentimentResult, SourceAnalysis } from './types';

const analyzer = new Sentiment();

const FINANCIAL_EXTRAS = {
  extras: {
    bullish: 3, rally: 3, surge: 3, gain: 2, rises: 2,
    yes: 1, approve: 2, win: 2, victory: 2,
    bearish: -3, crash: -3, plunge: -3, decline: -2, fall: -2,
    fail: -2, reject: -2, lose: -2, defeated: -2, veto: -2,
  },
};

export class SentimentAnalyzer {
  /** Analyze sentiment of a single piece of text */
  analyze(text: string): SentimentResult {
    if (!text || text.length < 5) {
      return { score: 0, label: 'neutral', confidence: 0, keywords: [] };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = analyzer.analyze(text, FINANCIAL_EXTRAS as any);
    const rawScore = result.comparative; // normalized by word count

    // Convert to -1..1 scale
    const normalizedScore = Math.max(-1, Math.min(1, rawScore / 2));

    const label =
      normalizedScore > 0.1
        ? 'bullish'
        : normalizedScore < -0.1
        ? 'bearish'
        : 'neutral';

    const confidence = Math.min(1, Math.abs(normalizedScore) * 2 + 0.2);

    // Extract top positive and negative keywords
    const keywords = [
      ...result.positive.slice(0, 3),
      ...result.negative.slice(0, 3),
    ];

    return { score: normalizedScore, label, confidence, keywords };
  }

  /** Analyze a batch of scraped items */
  analyzeBatch(items: ScrapedItem[]): SourceAnalysis[] {
    return items.map((item) => {
      const combinedText = `${item.title} ${item.rawContent}`;
      const sentiment = this.analyze(combinedText);
      const credibilityScore = this.estimateCredibility(item);
      return { item, sentiment, credibilityScore };
    });
  }

  /** Weighted average sentiment across sources */
  aggregateSentiment(analyses: SourceAnalysis[]): {
    score: number;
    label: 'bullish' | 'bearish' | 'neutral';
    consensus: string;
  } {
    if (analyses.length === 0) {
      return { score: 0, label: 'neutral', consensus: 'No sources found.' };
    }

    let weightedSum = 0;
    let totalWeight = 0;

    for (const analysis of analyses) {
      const weight = analysis.credibilityScore * analysis.sentiment.confidence;
      weightedSum += analysis.sentiment.score * weight;
      totalWeight += weight;
    }

    const avgScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const label =
      avgScore > 0.1 ? 'bullish' : avgScore < -0.1 ? 'bearish' : 'neutral';

    const bullCount = analyses.filter((a) => a.sentiment.label === 'bullish').length;
    const bearCount = analyses.filter((a) => a.sentiment.label === 'bearish').length;
    const consensus = `${bullCount} bullish, ${bearCount} bearish out of ${analyses.length} sources. Weighted score: ${avgScore.toFixed(3)}.`;

    return { score: avgScore, label, consensus };
  }

  private estimateCredibility(item: ScrapedItem): number {
    // Use pre-computed domain credibility if available (set by scraper)
    if (item.domainCredibility !== undefined) return item.domainCredibility;
    switch (item.sourcePlatform) {
      case 'news': return 0.8;
      case 'reddit': return 0.5;
      case 'stocktwits': return 0.6;
      default: return 0.4;
    }
  }
}
