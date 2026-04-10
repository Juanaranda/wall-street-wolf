import { Market, Platform } from '../shared/types';

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  marketId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: Date;
}

export interface MarketFilter {
  minVolume24h: number;        // minimum 24h volume in contracts
  minLiquidity: number;        // minimum total liquidity
  maxDaysToExpiry: number;     // max days until resolution
  minSpread: number;           // ignore markets with spread below this
  maxSpread: number;           // ignore markets with spread above this (illiquid)
  demoMode: boolean;           // relaxes all filters for demo/paper trading
}

export interface AnomalyFlags {
  priceMove10pct: boolean;     // sudden >10% price move
  wideSpread: boolean;         // spread wider than 5 cents
  volumeSpike: boolean;        // volume > 2x 7-day average
  lowLiquidity: boolean;
}

export interface ScoredMarket {
  market: Market;
  orderBook: OrderBook;
  anomalies: AnomalyFlags;
  opportunityScore: number;    // 0–100; higher = better to investigate
  spreadWidth: number;
  volumeSpike: number;         // ratio vs 7-day avg
  daysToExpiry: number;
}

export interface PolymarketApiMarket {
  condition_id: string;
  question: string;
  description: string;
  category: string;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  tokens: Array<{ token_id: string; outcome: string; price: number }>;
  volume: number;
  liquidity: number;
  tags?: string[];
}

export interface KalshiApiMarket {
  ticker: string;
  title: string;
  category: string;
  close_time: string;
  status: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  volume: number;
  open_interest: number;
}
