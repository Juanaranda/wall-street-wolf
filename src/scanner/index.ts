import { Market, MarketSignal } from '../shared/types';
import { logger } from '../shared/logger';
import { PolymarketClient } from './polymarket';
import { KalshiClient } from './kalshi';
import {
  MarketFilter,
  ScoredMarket,
  AnomalyFlags,
  OrderBook,
} from './types';

// Production-grade defaults — enforced when demoMode=false
const PRODUCTION_FILTER: MarketFilter = {
  minVolume24h: 200,
  minLiquidity: 500,
  maxDaysToExpiry: 30,
  minSpread: 0.01,
  maxSpread: 0.15,
  demoMode: false,
};

// Demo defaults — relaxed so paper-trading works without real liquidity
const DEMO_FILTER: MarketFilter = {
  minVolume24h: 0,
  minLiquidity: 0,
  maxDaysToExpiry: 90,
  minSpread: 0.0,
  maxSpread: 0.40,
  demoMode: true,
};

const DEFAULT_FILTER = process.env['DEMO_MODE'] !== 'false' ? DEMO_FILTER : PRODUCTION_FILTER;

export class MarketScanner {
  private readonly poly: PolymarketClient;
  private readonly kalshi: KalshiClient;
  private readonly filter: MarketFilter;
  private priceHistory: Map<string, number[]> = new Map();
  // Rolling 7-day volume samples (one entry per scan cycle per market)
  private volumeHistory: Map<string, number[]> = new Map();

  constructor(
    polyApiUrl: string,
    kalshiApiUrl: string,
    kalshiApiKeyId: string,
    kalshiPrivateKey: string = '',
    filter: Partial<MarketFilter> = {}
  ) {
    this.poly = new PolymarketClient(polyApiUrl);
    this.kalshi = new KalshiClient(kalshiApiUrl, kalshiApiKeyId, kalshiPrivateKey);
    this.filter = { ...DEFAULT_FILTER, ...filter };
  }

  async initialize(): Promise<void> {
    await this.kalshi.authenticate();
  }

  /** Main scan: fetch, filter, score, and return ranked signals */
  async scan(): Promise<MarketSignal[]> {
    logger.info('Scanner: starting market scan');

    const [polyMarkets, kalshiMarkets] = await Promise.all([
      this.poly.fetchActiveMarkets(200),
      this.kalshi.fetchActiveMarkets(200),
    ]);

    const allMarkets = [...polyMarkets, ...kalshiMarkets];
    logger.info(`Scanner: fetched ${allMarkets.length} total markets`);

    const filtered = allMarkets.filter((m) => this.passesFilter(m));
    logger.info(`Scanner: ${filtered.length} markets pass initial filter`);

    const scored = await this.scoreMarkets(filtered);
    const ranked = scored.sort((a, b) => b.opportunityScore - a.opportunityScore);

    return ranked.map((s) => this.toSignal(s));
  }

  private passesFilter(market: Market): boolean {
    const now = new Date();
    const daysToExpiry =
      (market.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

    if (daysToExpiry < 0.5 || daysToExpiry > this.filter.maxDaysToExpiry) return false;
    if (market.volume24h < this.filter.minVolume24h) return false;
    if (market.totalLiquidity < this.filter.minLiquidity) return false;

    const spread = market.yesPrice + market.noPrice - 1;
    if (spread < this.filter.minSpread) return false;
    if (spread > this.filter.maxSpread) return false;

    return true;
  }

  private async scoreMarkets(markets: Market[]): Promise<ScoredMarket[]> {
    const results: ScoredMarket[] = [];

    for (const market of markets) {
      try {
        const obFetcher =
          market.platform === 'polymarket'
            ? this.poly.fetchOrderBook(market.id)
            : this.kalshi.fetchOrderBook(market.id);

        const orderBook = (await obFetcher) ?? this.emptyOrderBook(market.id);
        const anomalies = this.detectAnomalies(market, orderBook);
        const opportunityScore = this.calcOpportunityScore(market, anomalies, orderBook);
        const daysToExpiry =
          (market.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);

        results.push({
          market,
          orderBook,
          anomalies,
          opportunityScore,
          spreadWidth: market.yesPrice + market.noPrice - 1,
          volumeSpike: this.calcVolumeSpike(market),
          daysToExpiry,
        });
      } catch (err) {
        logger.warn(`Scanner: failed to score market ${market.id}`, { err });
      }
    }

    return results;
  }

  private detectAnomalies(market: Market, orderBook: OrderBook): AnomalyFlags {
    const prevPrices = this.priceHistory.get(market.id) ?? [];
    const spread = market.yesPrice + market.noPrice - 1;

    let priceMove10pct = false;
    if (prevPrices.length > 0) {
      const lastPrice = prevPrices[prevPrices.length - 1]!;
      priceMove10pct = Math.abs(market.yesPrice - lastPrice) / lastPrice > 0.1;
    }

    // Update history
    const updated = [...prevPrices.slice(-6), market.yesPrice];
    this.priceHistory.set(market.id, updated);

    const bestBid = orderBook.bids[0]?.price ?? 0;
    const bestAsk = orderBook.asks[0]?.price ?? 1;
    const obSpread = bestAsk - bestBid;

    return {
      priceMove10pct,
      wideSpread: obSpread > 0.05,
      volumeSpike: this.calcVolumeSpike(market) > 2,
      lowLiquidity: market.totalLiquidity < 500,
    };
  }

  private calcVolumeSpike(market: Market): number {
    const history = this.volumeHistory.get(market.id) ?? [];
    // Append current sample and keep rolling 7-day window (one entry per scan cycle)
    const updated = [...history.slice(-6), market.volume24h];
    this.volumeHistory.set(market.id, updated);

    if (updated.length < 2) return 1; // not enough history yet
    const avg = updated.slice(0, -1).reduce((s, v) => s + v, 0) / (updated.length - 1);
    return avg > 0 ? market.volume24h / avg : 1;
  }

  private calcOpportunityScore(
    market: Market,
    anomalies: AnomalyFlags,
    orderBook: OrderBook
  ): number {
    let score = 50;

    if (anomalies.priceMove10pct) score += 20;
    if (anomalies.volumeSpike) score += 15;
    if (!anomalies.wideSpread) score += 10;
    if (!anomalies.lowLiquidity) score += 10;

    const depth = orderBook.bids.slice(0, 5).reduce((s, l) => s + l.size, 0);
    if (depth > 1000) score += 5;

    const daysToExpiry =
      (market.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysToExpiry < 7) score += 10;

    return Math.min(100, Math.max(0, score));
  }

  private toSignal(scored: ScoredMarket): MarketSignal {
    return {
      market: scored.market,
      anomalyScore: scored.opportunityScore,
      spreadWidth: scored.spreadWidth,
      volumeSpike: scored.volumeSpike,
      orderBookDepth: scored.orderBook.bids
        .slice(0, 5)
        .reduce((s, l) => s + l.size, 0),
      tradeable: scored.opportunityScore >= 60,
      reason: this.buildReason(scored),
    };
  }

  private buildReason(scored: ScoredMarket): string {
    const parts: string[] = [];
    if (scored.anomalies.priceMove10pct) parts.push('price moved >10%');
    if (scored.anomalies.volumeSpike) parts.push('volume spike detected');
    if (scored.anomalies.wideSpread) parts.push('wide spread (illiquid)');
    if (scored.daysToExpiry < 7) parts.push('resolves within 7 days');
    return parts.join('; ') || 'standard filter pass';
  }

  private emptyOrderBook(marketId: string): OrderBook {
    return { marketId, bids: [], asks: [], timestamp: new Date() };
  }
}

export { MarketFilter, ScoredMarket } from './types';
