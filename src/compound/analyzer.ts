import fs from 'fs';
import path from 'path';
import { TradeRecord, PerformanceMetrics, FailureCategory } from '../shared/types';
import { logger } from '../shared/logger';
import { LessonEntry, DailyConsolidationReport } from './types';

const FAILURE_KB_PATH = './data/knowledge_base.jsonl';

export class PerformanceAnalyzer {
  private lessons: LessonEntry[] = [];

  constructor() {
    this.loadLessons();
  }

  /** Calculate performance metrics from all settled trades */
  calculateMetrics(records: TradeRecord[]): PerformanceMetrics {
    const settled = records.filter((r) => r.outcome !== undefined && r.pnl !== undefined);

    if (settled.length === 0) {
      return {
        winRate: 0, sharpeRatio: 0, maxDrawdown: 0,
        profitFactor: 0, avgBrierScore: 0.25,
        totalTrades: 0, profitableTrades: 0, totalPnl: 0, avgEdge: 0,
      };
    }

    const wins = settled.filter((r) => (r.pnl ?? 0) > 0);
    const losses = settled.filter((r) => (r.pnl ?? 0) <= 0);
    const winRate = wins.length / settled.length;

    const totalPnl = settled.reduce((s, r) => s + (r.pnl ?? 0), 0);
    const grossProfit = wins.reduce((s, r) => s + (r.pnl ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, r) => s + (r.pnl ?? 0), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Sharpe ratio (simplified: using daily PnL)
    const pnls = settled.map((r) => r.pnl ?? 0);
    const avgPnl = totalPnl / settled.length;
    const stdPnl = Math.sqrt(
      pnls.reduce((s, p) => s + Math.pow(p - avgPnl, 2), 0) / pnls.length
    );
    const sharpeRatio = stdPnl > 0 ? (avgPnl / stdPnl) * Math.sqrt(252) : 0;

    // Max drawdown — start peak at initialBankroll proxy (first running value)
    let running = 0, peak = 0, maxDrawdown = 0;
    for (const pnl of pnls) {
      running += pnl;
      if (running > peak) peak = running;
      // Only measure drawdown once we have a positive peak (avoid divide-by-zero)
      const drawdown = peak > 0 ? (peak - running) / peak : 0;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const brierScores = settled
      .filter((r) => r.brierScore !== undefined)
      .map((r) => r.brierScore!);
    const avgBrierScore = brierScores.length > 0
      ? brierScores.reduce((s, b) => s + b, 0) / brierScores.length
      : 0.25;

    const avgEdge = settled.reduce(
      (s, r) => s + (r.predictedProbability - r.marketProbabilityAtEntry), 0
    ) / settled.length;

    return {
      winRate,
      sharpeRatio,
      maxDrawdown,
      profitFactor,
      avgBrierScore,
      totalTrades: settled.length,
      profitableTrades: wins.length,
      totalPnl,
      avgEdge,
    };
  }

  /** Classify a losing trade and record the lesson */
  classifyFailure(record: TradeRecord): LessonEntry {
    const { failureCategory, lesson } = this.inferFailure(record);

    const entry: LessonEntry = {
      id: `lesson_${Date.now()}`,
      marketId: record.marketId,
      question: record.question,
      failureCategory,
      lesson,
      marketPrice: record.marketProbabilityAtEntry,
      predictedProbability: record.predictedProbability,
      pnl: record.pnl ?? 0,
      timestamp: new Date(),
    };

    this.lessons.push(entry);
    this.appendLessonToDisk(entry);
    logger.info('PerformanceAnalyzer: failure classified', { failureCategory, lesson });
    return entry;
  }

  /** Get recent lessons for a given market question (for RAG-style injection) */
  getRelevantLessons(question: string, limit: number = 5): LessonEntry[] {
    const words = new Set(question.toLowerCase().split(/\s+/).filter((w) => w.length > 4));
    return this.lessons
      .filter((l) => {
        const lWords = l.question.toLowerCase().split(/\s+/);
        return lWords.some((w) => words.has(w));
      })
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  /** Daily consolidation: generate summary report */
  consolidate(records: TradeRecord[]): DailyConsolidationReport {
    const today = new Date().toISOString().split('T')[0]!;
    const todayRecords = records.filter(
      (r) => r.openedAt.toISOString().split('T')[0] === today
    );

    const settled = todayRecords.filter((r) => r.pnl !== undefined);
    const wins = settled.filter((r) => (r.pnl ?? 0) > 0);
    const totalPnl = settled.reduce((s, r) => s + (r.pnl ?? 0), 0);
    const grossProfit = wins.reduce((s, r) => s + (r.pnl ?? 0), 0);
    const grossLoss = Math.abs(
      settled.filter((r) => (r.pnl ?? 0) < 0).reduce((s, r) => s + (r.pnl ?? 0), 0)
    );

    const brierScores = settled
      .filter((r) => r.brierScore !== undefined)
      .map((r) => r.brierScore!);
    const avgBrierScore = brierScores.length > 0
      ? brierScores.reduce((s, b) => s + b, 0) / brierScores.length
      : 0.25;

    const newLessons = this.lessons.filter(
      (l) => l.timestamp.toISOString().split('T')[0] === today
    );

    return {
      date: today,
      totalTrades: todayRecords.length,
      wins: wins.length,
      losses: settled.length - wins.length,
      totalPnl,
      avgBrierScore,
      winRate: settled.length > 0 ? wins.length / settled.length : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : 0,
      newLessons,
    };
  }

  getAllLessons(): LessonEntry[] {
    return [...this.lessons];
  }

  private inferFailure(record: TradeRecord): { failureCategory: FailureCategory; lesson: string } {
    const edge = record.predictedProbability - record.marketProbabilityAtEntry;

    if (record.failureCategory) {
      return { failureCategory: record.failureCategory, lesson: record.failureReason ?? 'No reason provided.' };
    }

    // External shock: large price move from entry to exit regardless of prediction quality
    if (record.entryPrice && record.exitPrice) {
      const priceMoved = Math.abs(record.exitPrice - record.entryPrice) / record.entryPrice;
      if (priceMoved > 0.15) {
        return {
          failureCategory: 'external_shock',
          lesson: `Large unexpected price move (${(priceMoved * 100).toFixed(1)}%). Market conditions changed rapidly — consider event-driven exit triggers.`,
        };
      }
    }

    // Bad execution: filled price was significantly worse than the quoted market price at entry
    // Only applies when entry was a YES position (entryPrice ≈ yes probability)
    if (record.entryPrice && record.direction === 'yes') {
      const executionSlippage = Math.abs(record.entryPrice - record.marketProbabilityAtEntry);
      if (executionSlippage > 0.05) {
        return {
          failureCategory: 'bad_execution',
          lesson: `Filled at ${(record.entryPrice * 100).toFixed(1)}% vs quoted ${(record.marketProbabilityAtEntry * 100).toFixed(1)}% — slippage of ${(executionSlippage * 100).toFixed(1)}%. Use tighter limit orders or skip illiquid markets.`,
        };
      }
    }

    // Bad timing: prediction was directionally correct (good edge) but trade still lost
    // Implies entry/exit timing was the issue, not the prediction itself
    if (edge > 0.05) {
      const daysHeld = record.closedAt && record.openedAt
        ? (record.closedAt.getTime() - record.openedAt.getTime()) / (1000 * 60 * 60 * 24)
        : null;
      const timingNote = daysHeld !== null
        ? ` Position held ${daysHeld.toFixed(1)} days.`
        : '';
      return {
        failureCategory: 'bad_timing',
        lesson: `Edge of ${(edge * 100).toFixed(1)}% was solid but trade lost — market moved against us before resolution.${timingNote} Consider scaling in or using time-based exits.`,
      };
    }

    // Bad prediction: edge was marginal or prediction was wrong
    if (Math.abs(edge) < 0.05) {
      return {
        failureCategory: 'bad_prediction',
        lesson: `Predicted ${(record.predictedProbability * 100).toFixed(1)}% but market was ${(record.marketProbabilityAtEntry * 100).toFixed(1)}%. Edge was marginal — below threshold trades are risky.`,
      };
    }

    return {
      failureCategory: 'bad_prediction',
      lesson: `Prediction of ${(record.predictedProbability * 100).toFixed(1)}% was inaccurate. Review sources and model calibration for this category.`,
    };
  }

  private loadLessons(): void {
    try {
      if (!fs.existsSync(FAILURE_KB_PATH)) return;
      const lines = fs.readFileSync(FAILURE_KB_PATH, 'utf8').trim().split('\n');
      this.lessons = lines.filter(Boolean).map((l) => {
        const entry = JSON.parse(l) as LessonEntry;
        entry.timestamp = new Date(entry.timestamp);
        return entry;
      });
      logger.info(`PerformanceAnalyzer: loaded ${this.lessons.length} lessons`);
    } catch (err) {
      logger.warn('PerformanceAnalyzer: failed to load lessons', { err });
    }
  }

  private appendLessonToDisk(entry: LessonEntry): void {
    try {
      const dir = path.dirname(FAILURE_KB_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(FAILURE_KB_PATH, JSON.stringify(entry) + '\n');
    } catch (err) {
      logger.error('PerformanceAnalyzer.appendLessonToDisk failed', { err });
    }
  }
}
