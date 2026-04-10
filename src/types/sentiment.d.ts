declare module 'sentiment' {
  interface SentimentResult {
    score: number;
    comparative: number;
    positive: string[];
    negative: string[];
    tokens: string[];
    words: string[];
  }
  interface SentimentOptions {
    labels?: Record<string, number>;
  }
  class Sentiment {
    analyze(phrase: string, options?: SentimentOptions): SentimentResult;
  }
  export = Sentiment;
}
