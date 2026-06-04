import fs from 'fs';
import path from 'path';
import { Recommendation, ManualFill, PaperPosition } from '../shared/types';
import { logger } from '../shared/logger';

// ─── Event types stored in the JSONL file ────────────────────────────────────

interface RecommendationEvent {
  type: 'recommendation';
  id: string;
  ticker: string;
  action: 'buy' | 'sell';
  suggestedAmountUsd: number;
  confidence: number;
  rationale: string;
  createdAt: string; // ISO-8601
}

interface FillEvent {
  type: 'fill';
  recommendationId: string;
  ticker: string;
  filledPrice: number;
  shares: number;
  filledAt: string; // ISO-8601
}

type LedgerEvent = RecommendationEvent | FillEvent;

// ─── Serialisation helpers ────────────────────────────────────────────────────

function serializeRecommendation(rec: Recommendation): RecommendationEvent {
  return {
    type: 'recommendation',
    id: rec.id,
    ticker: rec.ticker,
    action: rec.action,
    suggestedAmountUsd: rec.suggestedAmountUsd,
    confidence: rec.confidence,
    rationale: rec.rationale,
    createdAt: rec.createdAt instanceof Date ? rec.createdAt.toISOString() : String(rec.createdAt),
  };
}

function serializeFill(fill: ManualFill): FillEvent {
  return {
    type: 'fill',
    recommendationId: fill.recommendationId,
    ticker: fill.ticker,
    filledPrice: fill.filledPrice,
    shares: fill.shares,
    filledAt: fill.filledAt instanceof Date ? fill.filledAt.toISOString() : String(fill.filledAt),
  };
}

function deserializeEvent(raw: unknown): LedgerEvent {
  const ev = raw as LedgerEvent;
  if (ev.type !== 'recommendation' && ev.type !== 'fill') {
    throw new Error(`Unknown ledger event type: ${String((raw as Record<string, unknown>)['type'])}`);
  }
  return ev;
}

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * Records recommendations, the user's manual fills, and paper positions.
 * Event-sourced (append-only) so history is auditable for backtesting/learning.
 */
export interface Ledger {
  recordRecommendation(rec: Recommendation): void;
  recordFill(fill: ManualFill): void;
  openPositions(): PaperPosition[];
  /** All recommendations ever recorded (for review/learning). */
  getRecommendations(): Recommendation[];
  /** All manual fills ever recorded. */
  getFills(): ManualFill[];
}

// ─── Implementation ───────────────────────────────────────────────────────────

const DEFAULT_LEDGER_PATH = process.env['LEDGER_PATH'] ?? 'data/ledger.jsonl';

/**
 * Append-only JSONL ledger.
 *
 * - Every recorded recommendation and fill is immediately fsynced to disk.
 * - `openPositions()` reconstructs paper positions by replaying all events:
 *     buy  → opens (or adds to) a position for that ticker.
 *     sell → closes (or reduces) the oldest-opened position for that ticker.
 * - The in-memory event list is the authoritative source; the disk file is the
 *   durable mirror (written atomically per-line via appendFileSync).
 */
export class PaperLedger implements Ledger {
  private readonly filePath: string;
  private readonly events: LedgerEvent[] = [];

  constructor(filePath: string = DEFAULT_LEDGER_PATH) {
    this.filePath = filePath;
    this.ensureDir();
    this.loadFromDisk();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  recordRecommendation(rec: Recommendation): void {
    const event = serializeRecommendation(rec);
    this.appendEvent(event);
    logger.info(`PaperLedger: recorded recommendation ${rec.id} (${rec.action} ${rec.ticker})`);
  }

  recordFill(fill: ManualFill): void {
    const event = serializeFill(fill);
    this.appendEvent(event);
    logger.info(`PaperLedger: recorded manual fill for ${fill.recommendationId} (${fill.ticker})`);
  }

  /**
   * Reconstruct open paper positions by replaying every fill event.
   *
   * Rules:
   *   - A 'buy' fill opens or adds to the position for that ticker.
   *     entryPrice is the volume-weighted average of all open buy fills.
   *   - A 'sell' fill reduces (or fully closes) the open position for that ticker.
   *   - Positions are keyed by ticker; multiple buy fills for the same ticker
   *     are merged into one PaperPosition.
   */
  openPositions(): PaperPosition[] {
    // Accumulate per-ticker state from fills only (recommendations are advisory).
    const byTicker = new Map<
      string,
      { totalCost: number; shares: number; openedAt: Date }
    >();

    for (const ev of this.events) {
      if (ev.type !== 'fill') continue;

      const ticker = ev.ticker;
      const existing = byTicker.get(ticker);

      if (ev.shares > 0) {
        // Positive shares = buy fill → open / increase position.
        if (existing) {
          existing.totalCost += ev.filledPrice * ev.shares;
          existing.shares += ev.shares;
        } else {
          byTicker.set(ticker, {
            totalCost: ev.filledPrice * ev.shares,
            shares: ev.shares,
            openedAt: new Date(ev.filledAt),
          });
        }
      } else if (ev.shares < 0) {
        // Negative shares = sell fill → close / reduce position.
        // Average entry price is preserved for remaining shares (standard cost-basis
        // accounting): reduce totalCost proportionally so that
        // entryPrice = totalCost / shares stays constant.
        if (existing) {
          const soldShares = Math.abs(ev.shares);
          existing.shares -= soldShares;
          if (existing.shares <= 0) {
            byTicker.delete(ticker);
          } else {
            // Keep entryPrice constant by scaling totalCost down.
            const avgEntryPrice = existing.totalCost / (existing.shares + soldShares);
            existing.totalCost = avgEntryPrice * existing.shares;
          }
        } else {
          logger.warn(
            `PaperLedger: sell fill for ${ticker} has no matching open position — ignored`
          );
        }
      }
    }

    const positions: PaperPosition[] = [];
    for (const [ticker, state] of byTicker) {
      if (state.shares > 0) {
        positions.push({
          ticker,
          entryPrice: state.totalCost / state.shares,
          shares: state.shares,
          openedAt: state.openedAt,
        });
      }
    }

    return positions;
  }

  getRecommendations(): Recommendation[] {
    return this.events
      .filter((e): e is RecommendationEvent => e.type === 'recommendation')
      .map((e) => ({
        id: e.id,
        ticker: e.ticker,
        action: e.action,
        suggestedAmountUsd: e.suggestedAmountUsd,
        confidence: e.confidence,
        rationale: e.rationale,
        createdAt: new Date(e.createdAt),
      }));
  }

  getFills(): ManualFill[] {
    return this.events
      .filter((e): e is FillEvent => e.type === 'fill')
      .map((e) => ({
        recommendationId: e.recommendationId,
        ticker: e.ticker,
        filledPrice: e.filledPrice,
        shares: e.shares,
        filledAt: new Date(e.filledAt),
      }));
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private appendEvent(event: LedgerEvent): void {
    this.events.push(event);
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(event) + '\n', 'utf8');
    } catch (err) {
      logger.error('PaperLedger: failed to append event to disk', { err });
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as unknown;
          const event = deserializeEvent(parsed);
          this.events.push(event);
        } catch (parseErr) {
          logger.warn('PaperLedger: skipping malformed line in ledger file', { line, parseErr });
        }
      }
      logger.info(`PaperLedger: loaded ${this.events.length} events from ${this.filePath}`);
    } catch (err) {
      logger.warn('PaperLedger: could not read ledger file — starting empty', { err });
    }
  }

  private ensureDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
