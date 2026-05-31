import { Market, MarketSignal } from '../shared/types';
import { logger } from '../shared/logger';
import { PolymarketClient } from './polymarket';
import { KalshiClient } from './kalshi';
import { BinanceClient } from './binance';
import { AlpacaClient } from './alpaca';
import { calculateIndicators } from '../indicators';
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
  private readonly binance: BinanceClient | null;
  private readonly alpaca: AlpacaClient | null;
  private readonly filter: MarketFilter;
  private priceHistory: Map<string, number[]> = new Map();
  // Rolling 7-day volume samples (one entry per scan cycle per market)
  private volumeHistory: Map<string, number[]> = new Map();

  constructor(
    polyApiUrl: string,
    kalshiApiUrl: string,
    kalshiApiKeyId: string,
    kalshiPrivateKey: string = '',
    filter: Partial<MarketFilter> = {},
    binanceApiUrl?: string,
    alpacaApiKey?: string,
    alpacaApiSecret?: string,
    alpacaPaper?: boolean
  ) {
    this.poly = new PolymarketClient(polyApiUrl);
    this.kalshi = new KalshiClient(kalshiApiUrl, kalshiApiKeyId, kalshiPrivateKey);
    this.filter = { ...DEFAULT_FILTER, ...filter };

    // Only instantiate Binance client if API URL is provided
    this.binance = binanceApiUrl
      ? new BinanceClient(binanceApiUrl)
      : null;

    // Only instantiate Alpaca client if both API key and secret are provided
    this.alpaca =
      alpacaApiKey && alpacaApiSecret
        ? new AlpacaClient(alpacaApiKey, alpacaApiSecret, alpacaPaper ?? true)
        : null;
  }

  async initialize(): Promise<void> {
    await this.kalshi.authenticate();
  }

  /** Main scan: fetch, filter, score, and return ranked signals */
  async scan(): Promise<MarketSignal[]> {
    logger.info('Scanner: starting market scan');

    const polyKey =
      process.env['POLYMARKET_PRIVATE_KEY_DEV'] ?? process.env['POLYMARKET_PRIVATE_KEY'] ?? '';
    const polyDisabled =
      !polyKey ||
      polyKey === '0x0000000000000000000000000000000000000000000000000000000000000001';

    const [polyMarkets, kalshiMarkets, binanceMarkets, alpacaMarkets] = await Promise.all([
      polyDisabled ? Promise.resolve([]) : this.poly.fetchActiveMarkets(200),
      this.kalshi.fetchActiveMarkets(200),
      this.binance ? this.binance.fetchActiveMarkets(50) : Promise.resolve([]),
      this.alpaca ? this.alpaca.fetchActiveMarkets(30) : Promise.resolve([]),
    ]);

    if (polyDisabled) {
      logger.info('Scanner: Polymarket disabled (no real credentials) — skipping');
    }
    if (!this.binance) {
      logger.info('Scanner: Binance disabled (no API URL configured) — skipping');
    }
    if (!this.alpaca) {
      logger.info('Scanner: Alpaca disabled (no API keys configured) — skipping');
    }

    const allMarkets = [...polyMarkets, ...kalshiMarkets, ...binanceMarkets, ...alpacaMarkets];
    logger.info(`Scanner: fetched ${allMarkets.length} total markets`);

    const filtered = allMarkets.filter((m) => this.passesFilter(m));
    logger.info(`Scanner: ${filtered.length} markets pass initial filter`);

    const scored = await this.scoreMarkets(filtered);

    // Boost Binance markets that have a 'buy' technical signal
    if (this.binance) {
      await this.applyTechnicalBoost(scored);
    }

    const ranked = scored.sort((a, b) => b.opportunityScore - a.opportunityScore);

    return ranked.map((s) => this.toSignal(s));
  }

  /** Fetch klines for Binance markets, run indicators, and boost opportunityScore on 'buy' signal. */
  private async applyTechnicalBoost(scored: ScoredMarket[]): Promise<void> {
    const binanceMarkets = scored.filter((s) => s.market.platform === 'binance');
    await Promise.all(
      binanceMarkets.map(async (s) => {
        try {
          const closes = await this.binance!.fetchKlines(s.market.id, '1h', 100);
          if (closes.length < 14) return;
          const indicators = calculateIndicators(closes);
          if (indicators.signal === 'buy' && indicators.strength > 0.6) {
            s.opportunityScore = Math.min(100, s.opportunityScore + 15);
            logger.info(`Scanner: technical buy signal for ${s.market.id}`, {
              rsi: indicators.rsi,
              macdHistogram: indicators.macd?.histogram,
              strength: indicators.strength,
            });
          }
        } catch (err) {
          logger.warn(`Scanner: technical boost failed for ${s.market.id}`, { err });
        }
      })
    );
  }

  private passesFilter(market: Market): boolean {
    const now = new Date();
    const daysToExpiry =
      (market.expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

    if (daysToExpiry < 0.5 || daysToExpiry > this.filter.maxDaysToExpiry) return false;
    if (market.volume24h < this.filter.minVolume24h) return false;
    if (market.totalLiquidity < this.filter.minLiquidity) return false;

    // Crypto/stock markets don't have a meaningful yes+no spread — skip that check
    if (market.platform === 'binance' || market.platform === 'alpaca') return true;

    const spread = market.yesPrice + market.noPrice - 1;
    if (spread < this.filter.minSpread) return false;
    if (spread > this.filter.maxSpread) return false;

    return true;
  }

  private async scoreMarkets(markets: Market[]): Promise<ScoredMarket[]> {
    const results: ScoredMarket[] = [];

    for (const market of markets) {
      try {
        let orderBook: OrderBook;

        if (market.platform === 'polymarket') {
          orderBook = (await this.poly.fetchOrderBook(market.id)) ?? this.emptyOrderBook(market.id);
        } else if (market.platform === 'kalshi') {
          orderBook = (await this.kalshi.fetchOrderBook(market.id)) ?? this.emptyOrderBook(market.id);
        } else if (market.platform === 'binance' && this.binance) {
          orderBook = await this.binance.fetchOrderBook(market.id);
        } else if (market.platform === 'alpaca' && this.alpaca) {
          orderBook = (await this.alpaca.fetchOrderBook(market.id)) ?? this.emptyOrderBook(market.id);
        } else {
          orderBook = this.emptyOrderBook(market.id);
        }

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

    // For crypto/stock use a wider spread threshold (prices are in dollars, not 0-1)
    const spreadThreshold =
      market.platform === 'binance' || market.platform === 'alpaca' ? 10 : 0.05;

    return {
      priceMove10pct,
      wideSpread: obSpread > spreadThreshold,
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
