import schedule from 'node-schedule';
import { logger } from './shared/logger';
import { loadConfig } from './shared/config';
import { isKillSwitchActive, sleep } from './shared/utils';
import { MarketScanner } from './scanner/index';
import { ResearchAgent } from './research/index';
import { PredictionEngine } from './prediction/index';
import { RiskGuard } from './risk/guards';
import { ExecutionEngine } from './execution/index';
import { CompoundService } from './compound/index';
import { db } from './shared/database';
import { MarketSignal } from './shared/types';

/** Tracks open positions pending resolution */
interface TrackedPosition {
  marketId: string;
  tradeId: string;
  predictedProbability: number;
  direction: 'yes' | 'no';
  entryPrice: number;
  size: number;
  expiresAt: Date;
}

const MAX_PARALLEL_MARKETS = 3;

export class TradingOrchestrator {
  private readonly scanner: MarketScanner;
  private readonly researcher: ResearchAgent;
  private readonly predictor: PredictionEngine;
  private readonly riskGuard: RiskGuard;
  private readonly executor: ExecutionEngine;
  private readonly compound: CompoundService;
  private isRunning = false;
  private job: schedule.Job | null = null;
  private openPositions: Map<string, TrackedPosition> = new Map();

  constructor() {
    const config = loadConfig();

    this.scanner = new MarketScanner(
      config.polymarket.apiUrl,
      config.kalshi.apiUrl,
      config.kalshi.apiKeyId,
      config.kalshi.privateKey,
      {
        maxDaysToExpiry: 90,
      },
      config.binance.apiUrl || undefined,
      config.alpaca.apiKey || undefined,
      config.alpaca.apiSecret || undefined,
      config.alpaca.paperTrading
    );

    this.researcher = new ResearchAgent(
      process.env['NEWS_API_KEY'] ?? '',
      (question) => this.compound.getRelevantLessons(question).map((l) => l.lesson)
    );

    this.predictor = new PredictionEngine(
      config.ai.openRouterApiKey
    );

    this.riskGuard = new RiskGuard(
      parseFloat(process.env['INITIAL_BANKROLL'] ?? '10000'),
      {
        minEdge: config.trading.minEdge,
        maxPositionSizeUsd: config.trading.maxPositionSizeUsd,
        maxTotalExposureUsd: config.trading.maxTotalExposureUsd,
        maxDailyLossUsd: config.trading.maxDailyLossUsd,
        maxDrawdownPct: config.trading.maxDrawdownPct,
        maxConcurrentPositions: config.trading.maxConcurrentPositions,
        kellyFraction: config.trading.kellyFraction,
        maxDailyApiCostUsd: config.trading.maxDailyApiCostUsd,
      }
    );

    this.executor = new ExecutionEngine(
      config.polymarket.privateKey,
      config.polymarket.apiKey,
      config.polymarket.secret,
      config.polymarket.passphrase,
      config.kalshi.apiKeyId,
      config.kalshi.privateKey,
      config.polymarket.apiUrl,
      config.kalshi.apiUrl,
      config.binance.apiKey || undefined,
      config.binance.apiSecret || undefined,
      config.binance.apiUrl || undefined,
      config.binance.testnet,
      config.alpaca.apiKey || undefined,
      config.alpaca.apiSecret || undefined,
      config.alpaca.paperTrading
    );

    this.compound = new CompoundService(config.logging.tradeLogPath);
  }

  async initialize(): Promise<void> {
    logger.info('Orchestrator: initializing...');
    await Promise.all([
      this.scanner.initialize(),
      this.executor.initialize(),
      db.connect(),
    ]);
    logger.info('Orchestrator: ready');
  }

  /** Run a single full pipeline cycle */
  async runCycle(): Promise<void> {
    if (isKillSwitchActive()) {
      logger.warn('Orchestrator: kill switch active — skipping cycle');
      return;
    }

    logger.info('Orchestrator: starting pipeline cycle');
    this.researcher.clearCache();

    // Step 1: Scan
    const signals = await this.scanner.scan();
    const tradeable = signals.filter((s) => s.tradeable);
    logger.info(`Orchestrator: ${tradeable.length} tradeable signals found`);

    // Step 2-5: Process each signal (batched for concurrency control)
    for (let i = 0; i < tradeable.length; i += MAX_PARALLEL_MARKETS) {
      if (isKillSwitchActive()) break;

      const batch = tradeable.slice(i, i + MAX_PARALLEL_MARKETS);
      await Promise.all(batch.map((signal) => this.processSignal(signal)));
    }

    // Performance logging
    const metrics = this.compound.getPerformanceMetrics();
    logger.info('Orchestrator: cycle complete', {
      winRate: metrics.winRate,
      totalPnl: metrics.totalPnl,
      sharpeRatio: metrics.sharpeRatio,
    });
  }

  private async processSignal(signal: MarketSignal): Promise<void> {
    const { market } = signal;

    try {
      // Step 2: Research
      const brief = await this.researcher.research(signal);

      // Step 3: Predict
      const daysToExpiry =
        (market.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      const prediction = await this.predictor.predict(brief, daysToExpiry);

      if (prediction.direction === 'pass') {
        logger.info(`Orchestrator: pass on ${market.id} (edge too small)`);
        return;
      }

      // Step 4: Risk
      const risk = this.riskGuard.assess(prediction);
      if (!risk.approved) {
        logger.info(`Orchestrator: risk rejected ${market.id}`, {
          reasons: risk.rejectionReasons,
        });
        return;
      }

      // Step 5: Execute
      const tradeResult = await this.executor.execute(prediction, risk, market.platform);
      if (!tradeResult) return;

      this.riskGuard.recordTrade(tradeResult.filledSize);

      // Track position for outcome resolution + concurrent position guard
      if (prediction.direction === 'yes' || prediction.direction === 'no') {
        const record = this.compound.recordExecution(tradeResult, prediction, market.question);
        this.openPositions.set(market.id, {
          marketId: market.id,
          tradeId: record.tradeId,
          predictedProbability: prediction.modelProbability,
          direction: prediction.direction,
          entryPrice: tradeResult.filledPrice,
          size: tradeResult.filledSize,
          expiresAt: market.expiresAt,
        });
        this.riskGuard.openPosition(
          market.id,
          market.platform,
          prediction.direction,
          tradeResult.filledSize,
          tradeResult.filledPrice
        );
      }

      logger.info(`Orchestrator: trade placed on ${market.id}`, {
        direction: tradeResult.direction,
        size: tradeResult.filledSize,
        price: tradeResult.filledPrice,
      });
    } catch (err) {
      logger.error(`Orchestrator: error processing signal ${market.id}`, { err });
    }
  }

  /** Start scheduled runs */
  start(intervalMs: number = 900_000): void {
    logger.info(`Orchestrator: starting scheduler (interval: ${intervalMs}ms)`);
    this.isRunning = true;

    // Run immediately on start
    void this.runCycle();

    // Schedule repeating runs
    const intervalMinutes = Math.max(1, Math.floor(intervalMs / 60_000));
    this.job = schedule.scheduleJob(`*/${intervalMinutes} * * * *`, () => {
      if (this.isRunning && !isKillSwitchActive()) {
        void this.runCycle();
      }
    });

    // Auto-hedge monitor — every 15 min between scan cycles
    schedule.scheduleJob('*/15 * * * *', () => {
      if (this.isRunning) void this.checkHedges();
    });

    // Resolution checker — every 30 min
    schedule.scheduleJob('*/30 * * * *', () => {
      if (this.isRunning) void this.checkResolutions();
    });

    // Nightly consolidation at 11:59 PM
    schedule.scheduleJob('59 23 * * *', () => {
      const report = this.compound.runDailyConsolidation();
      logger.info('Orchestrator: nightly consolidation', {
        trades: report.totalTrades,
        winRate: report.winRate,
        pnl: report.totalPnl,
      });
    });
  }

  /**
   * Auto-hedge: scan open positions and exit any that have moved adversely.
   * A position is hedged (cancelled/exited) when:
   *   - Price moved > 15% against our direction since entry, OR
   *   - New information pushed the market past our stop (price crossed 0.85/0.15)
   */
  private async checkHedges(): Promise<void> {
    if (this.openPositions.size === 0) return;

    const signals = await this.scanner.scan().catch(() => []);
    if (signals.length === 0) return;

    for (const [marketId, pos] of this.openPositions) {
      const signal = signals.find((s) => s.market.id === marketId);
      if (!signal) continue;

      const currentPrice = signal.market.yesPrice;
      this.riskGuard.updatePositionPrice(marketId, currentPrice);

      // Determine adverse move threshold
      const entryPrice = pos.direction === 'yes' ? currentPrice : 1 - currentPrice;
      const priceMovedAgainst =
        pos.direction === 'yes'
          ? currentPrice < entryPrice * 0.85   // YES position: price dropped >15%
          : currentPrice > entryPrice * 1.15;  // NO position: yes price rose >15%

      // Hard stop: market has resolved against us
      const marketResolvingAgainst =
        (pos.direction === 'yes' && currentPrice < 0.10) ||
        (pos.direction === 'no' && currentPrice > 0.90);

      if (priceMovedAgainst || marketResolvingAgainst) {
        logger.warn(`Orchestrator: auto-hedge triggered for ${marketId}`, {
          direction: pos.direction,
          currentPrice,
          priceMovedAgainst,
          marketResolvingAgainst,
        });
        // Exit by placing opposing limit order
        try {
          await this.executor.cancelOrder(signal.market.platform, marketId);
        } catch {
          // Best effort — log and continue
        }
        this.riskGuard.closePosition(marketId, currentPrice);
        this.openPositions.delete(marketId);
      }
    }
  }

  /**
   * Check if any tracked positions have expired and fetch their resolution.
   * Called on a separate schedule (every 30 min) so it doesn't block the main cycle.
   */
  private async checkResolutions(): Promise<void> {
    const now = new Date();
    const expired = [...this.openPositions.values()].filter(
      (p) => p.expiresAt <= now
    );

    if (expired.length === 0) return;
    logger.info(`Orchestrator: checking resolution for ${expired.length} expired positions`);

    for (const pos of expired) {
      try {
        // Fetch final market state to determine outcome
        const signals = await this.scanner.scan();
        const resolved = signals.find((s) => s.market.id === pos.marketId);

        let outcome: boolean | null = null;
        if (resolved) {
          // If yesPrice > 0.95 → resolved YES; if < 0.05 → resolved NO
          if (resolved.market.yesPrice > 0.95) outcome = true;
          else if (resolved.market.yesPrice < 0.05) outcome = false;
        }

        if (outcome !== null) {
          const exitPrice = outcome ? 1 : 0;
          // pnl = (exit - entry) * size for YES; (entry - exit) * size for NO
          const pnl = pos.direction === 'yes'
            ? (exitPrice - pos.entryPrice) * pos.size
            : ((1 - exitPrice) - (1 - pos.entryPrice)) * pos.size;

          this.compound.recordSettlement(pos.tradeId, outcome, exitPrice, pnl);
          this.predictor.recordOutcome(pos.marketId, pos.predictedProbability, outcome);
          this.riskGuard.closePosition(pos.marketId, exitPrice);
          this.openPositions.delete(pos.marketId);
          logger.info(`Orchestrator: recorded outcome for ${pos.marketId}`, { outcome, pnl });
        }
      } catch (err) {
        logger.warn(`Orchestrator: could not resolve ${pos.marketId}`, { err });
      }
    }
  }

  stop(): void {
    logger.info('Orchestrator: stopping...');
    this.isRunning = false;
    if (this.job) {
      this.job.cancel();
      this.job = null;
    }
  }
}
