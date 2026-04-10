import { TradeRecord, TradeResult, PredictionResult, PerformanceMetrics } from '../shared/types';
import { logger } from '../shared/logger';
import { generateTradeId, brierScore } from '../shared/utils';
import { TradeLogger } from './trade-logger';
import { PerformanceAnalyzer } from './analyzer';
import { DailyConsolidationReport } from './types';

export class CompoundService {
  private readonly tradeLogger: TradeLogger;
  private readonly analyzer: PerformanceAnalyzer;

  constructor(tradeLogPath?: string) {
    this.tradeLogger = new TradeLogger(tradeLogPath);
    this.analyzer = new PerformanceAnalyzer();
  }

  /** Record a new trade execution */
  recordExecution(
    result: TradeResult,
    prediction: PredictionResult,
    question: string
  ): TradeRecord {
    const record: TradeRecord = {
      tradeId: result.orderId || generateTradeId(),
      marketId: result.marketId,
      platform: result.platform,
      question,
      direction: result.direction,
      predictedProbability: prediction.modelProbability,
      marketProbabilityAtEntry: prediction.marketProbability,
      entryPrice: result.filledPrice,
      size: result.filledSize,
      openedAt: result.timestamp,
    };

    this.tradeLogger.append(record);
    logger.info('CompoundService: trade recorded', { tradeId: record.tradeId });
    return record;
  }

  /** Record settlement of a resolved market */
  recordSettlement(
    tradeId: string,
    outcome: boolean,
    exitPrice: number,
    pnl: number
  ): void {
    const records = this.tradeLogger.getAll();
    const record = records.find((r) => r.tradeId === tradeId);
    if (!record) {
      logger.warn('CompoundService.recordSettlement: trade not found', { tradeId });
      return;
    }

    const bs = brierScore(record.predictedProbability, outcome);

    const updates: Partial<TradeRecord> = {
      outcome,
      exitPrice,
      pnl,
      brierScore: bs,
      closedAt: new Date(),
    };

    // Classify failures
    if (pnl < 0) {
      const lesson = this.analyzer.classifyFailure({ ...record, ...updates } as TradeRecord);
      updates.failureCategory = lesson.failureCategory;
      updates.failureReason = lesson.lesson;
    }

    this.tradeLogger.update(tradeId, updates);
    logger.info('CompoundService: settlement recorded', { tradeId, outcome, pnl, brierScore: bs });
  }

  getPerformanceMetrics(): PerformanceMetrics {
    return this.analyzer.calculateMetrics(this.tradeLogger.getAll());
  }

  runDailyConsolidation(): DailyConsolidationReport {
    const report = this.analyzer.consolidate(this.tradeLogger.getAll());
    logger.info('CompoundService: daily consolidation complete', {
      date: report.date,
      trades: report.totalTrades,
      winRate: report.winRate,
      pnl: report.totalPnl,
    });
    return report;
  }

  getRelevantLessons(question: string) {
    return this.analyzer.getRelevantLessons(question);
  }
}

export { TradeLogger, PerformanceAnalyzer };
