import fs from 'fs';
import path from 'path';
import { TradeRecord } from '../shared/types';
import { logger } from '../shared/logger';

export class TradeLogger {
  private readonly logPath: string;
  private records: TradeRecord[] = [];

  constructor(logPath: string = './data/trades.jsonl') {
    this.logPath = logPath;
    this.ensureDir();
    this.loadFromDisk();
  }

  append(record: TradeRecord): void {
    this.records.push(record);
    try {
      fs.appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    } catch (err) {
      logger.error('TradeLogger.append failed', { err });
    }
  }

  /** Update an existing record (e.g., when a trade settles) */
  update(tradeId: string, updates: Partial<TradeRecord>): void {
    const idx = this.records.findIndex((r) => r.tradeId === tradeId);
    if (idx < 0) return;
    this.records[idx] = { ...this.records[idx]!, ...updates };
    this.rewriteDisk();
  }

  getAll(): TradeRecord[] {
    return [...this.records];
  }

  getUnsettled(): TradeRecord[] {
    return this.records.filter((r) => r.outcome === undefined);
  }

  getByMarket(marketId: string): TradeRecord[] {
    return this.records.filter((r) => r.marketId === marketId);
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.logPath)) return;
      const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n');
      this.records = lines
        .filter(Boolean)
        .map((l) => {
          const r = JSON.parse(l) as TradeRecord;
          r.openedAt = new Date(r.openedAt);
          if (r.closedAt) r.closedAt = new Date(r.closedAt);
          return r;
        });
      logger.info(`TradeLogger: loaded ${this.records.length} records`);
    } catch (err) {
      logger.warn('TradeLogger: failed to load from disk', { err });
    }
  }

  private rewriteDisk(): void {
    try {
      const content = this.records.map((r) => JSON.stringify(r)).join('\n') + '\n';
      fs.writeFileSync(this.logPath, content);
    } catch (err) {
      logger.error('TradeLogger.rewriteDisk failed', { err });
    }
  }

  private ensureDir(): void {
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
