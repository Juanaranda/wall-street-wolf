// Core shared types for the prediction market trading bot

export type Platform = 'polymarket' | 'kalshi' | 'binance' | 'alpaca';
export type Direction = 'yes' | 'no' | 'long' | 'short';
export type TradeStatus = 'filled' | 'partial' | 'rejected' | 'cancelled' | 'pending';
export type SentimentLabel = 'bullish' | 'bearish' | 'neutral';
export type FailureCategory =
  | 'bad_prediction'
  | 'bad_timing'
  | 'bad_execution'
  | 'external_shock';

// ── Market ──────────────────────────────────────────────────────────────────

export interface Market {
  id: string;
  platform: Platform;
  question: string;
  description: string;
  yesPrice: number; // 0–1
  noPrice: number;  // 0–1
  volume24h: number;
  totalLiquidity: number;
  expiresAt: Date;
  createdAt: Date;
  category: string;
  tags: string[];
}

export interface MarketSignal {
  market: Market;
  anomalyScore: number;
  spreadWidth: number;
  volumeSpike: number;
  orderBookDepth: number;
  tradeable: boolean;
  reason: string;
}

// ── Research ─────────────────────────────────────────────────────────────────

export interface SourceItem {
  url: string;
  title: string;
  content: string;
  sentiment: number; // -1 to 1
  credibilityScore: number; // 0–1
  publishedAt: Date;
  sourcePlatform: 'twitter' | 'reddit' | 'news' | 'other';
}

export interface ResearchBrief {
  marketId: string;
  sentiment: SentimentLabel;
  sentimentScore: number; // -1 to 1
  sources: SourceItem[];
  narrativeConsensus: string;
  currentMarketPrice: number;
  estimatedEdge: number;
  summary: string;
  timestamp: Date;
}

// ── Prediction ────────────────────────────────────────────────────────────────

export interface ModelVote {
  model: string;
  probability: number;
  weight: number;
  reasoning: string;
}

export interface PredictionResult {
  marketId: string;
  modelProbability: number;
  marketProbability: number;
  edge: number; // modelProbability - marketProbability
  confidence: number; // 0–1
  direction: Direction | 'pass';
  modelVotes: ModelVote[];
  brierScore?: number;
  mispricingScore: number; // z-score
  expectedValue: number;
  timestamp: Date;
}

// ── Risk ──────────────────────────────────────────────────────────────────────

export interface RiskCheck {
  name: string;
  passed: boolean;
  value: number;
  threshold: number;
}

export interface RiskAssessment {
  marketId: string;
  approved: boolean;
  rejectionReasons: string[];
  positionSize: number; // USD
  kellyFraction: number;
  maxExposure: number;
  valueAtRisk: number; // 95% confidence
  checks: RiskCheck[];
}

// ── Execution ─────────────────────────────────────────────────────────────────

export interface TradeOrder {
  marketId: string;
  platform: Platform;
  direction: Direction;
  size: number; // USD
  limitPrice: number;
  maxSlippage: number;
  timestamp: Date;
}

export interface TradeResult {
  orderId: string;
  marketId: string;
  platform: Platform;
  direction: Direction;
  filledSize: number;
  filledPrice: number;
  slippage: number;
  fees: number;
  status: TradeStatus;
  timestamp: Date;
}

// ── Portfolio ─────────────────────────────────────────────────────────────────

export interface Position {
  marketId: string;
  platform: Platform;
  direction: Direction;
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  openedAt: Date;
}

export interface PortfolioState {
  totalBankroll: number;
  availableCash: number;
  openPositions: Position[];
  dailyPnl: number;
  totalPnl: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
  sharpeRatio: number;
}

// ── Compound / Learning ───────────────────────────────────────────────────────

export interface TradeRecord {
  tradeId: string;
  marketId: string;
  platform: Platform;
  question: string;
  direction: Direction;
  predictedProbability: number;
  marketProbabilityAtEntry: number;
  entryPrice: number;
  exitPrice?: number;
  size: number;
  pnl?: number;
  outcome?: boolean;
  failureReason?: string;
  failureCategory?: FailureCategory;
  brierScore?: number;
  openedAt: Date;
  closedAt?: Date;
}

export interface PerformanceMetrics {
  winRate: number;
  sharpeRatio: number;
  maxDrawdown: number;
  profitFactor: number;
  avgBrierScore: number;
  totalTrades: number;
  profitableTrades: number;
  totalPnl: number;
  avgEdge: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface BotConfig {
  polymarket: {
    apiUrl: string;
    wsUrl: string;
    privateKey: string;
    apiKey: string;
    secret: string;
    passphrase: string;
  };
  kalshi: {
    apiUrl: string;
    apiKeyId: string;
    privateKey: string;
  };
  trading: {
    minEdge: number;
    minLiquidity: number;
    maxPositionSizeUsd: number;
    maxTotalExposureUsd: number;
    maxDailyLossUsd: number;
    maxDrawdownPct: number;
    maxConcurrentPositions: number;
    kellyFraction: number;
    scanIntervalMs: number;
    maxDailyApiCostUsd: number;
  };
  binance: {
    apiUrl: string;
    apiKey: string;
    apiSecret: string;
    testnet: boolean;
  };
  alpaca: {
    apiKey: string;
    apiSecret: string;
    paperTrading: boolean;
  };
  ai: {
    openRouterApiKey: string;
  };
  logging: {
    level: string;
    tradeLogPath: string;
    failureLogPath: string;
  };
}
