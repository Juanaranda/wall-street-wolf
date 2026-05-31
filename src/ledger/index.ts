import { Recommendation, ManualFill, PaperPosition } from '../shared/types';
import { logger } from '../shared/logger';

/**
 * Records recommendations, the user's manual fills, and paper positions.
 * Event-sourced (append-only) so history is auditable for backtesting/learning.
 */
export interface Ledger {
  recordRecommendation(rec: Recommendation): void;
  recordFill(fill: ManualFill): void;
  openPositions(): PaperPosition[];
}

/**
 * STUB — in-memory ledger. The ledger/ agent (issue #6) implements append-only
 * JSONL persistence and reconciliation of recommendations ↔ fills.
 */
export class PaperLedger implements Ledger {
  private readonly recommendations: Recommendation[] = [];
  private readonly fills: ManualFill[] = [];

  recordRecommendation(rec: Recommendation): void {
    this.recommendations.push(rec);
    logger.info(`PaperLedger: recorded recommendation ${rec.id} (${rec.action} ${rec.ticker})`);
  }

  recordFill(fill: ManualFill): void {
    this.fills.push(fill);
    logger.info(`PaperLedger: recorded manual fill for ${fill.recommendationId}`);
  }

  openPositions(): PaperPosition[] {
    // STUB — real reconciliation comes with issue #6.
    return [];
  }
}
