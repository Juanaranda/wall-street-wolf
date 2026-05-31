import fs from 'fs';
import path from 'path';
import { logger } from '../shared/logger';
import { CalibrationRecord } from './types';

const DEFAULT_LOG_PATH = './data/calibration.jsonl';

export class CalibrationTracker {
  private readonly logPath: string;
  private records: CalibrationRecord[] = [];

  constructor(logPath: string = DEFAULT_LOG_PATH) {
    this.logPath = logPath;
    this.loadFromDisk();
  }

  record(
    marketId: string,
    predicted: number,
    outcome: boolean
  ): CalibrationRecord {
    const bs = Math.pow(predicted - (outcome ? 1 : 0), 2);
    const entry: CalibrationRecord = {
      marketId,
      predictedProbability: predicted,
      actualOutcome: outcome,
      brierScore: bs,
      timestamp: new Date(),
    };
    this.records.push(entry);
    this.appendToDisk(entry);
    return entry;
  }

  /** Running average Brier Score (lower is better; 0.25 = random) */
  averageBrierScore(): number {
    if (this.records.length === 0) return 0.25;
    return (
      this.records.reduce((s, r) => s + r.brierScore, 0) / this.records.length
    );
  }

  /** Calibration check: are 70% predictions right 70% of the time? */
  calibrationStats(): Record<string, { predicted: number; actualRate: number; count: number }> {
    const buckets: Record<string, { sum: number; outcomes: number; count: number }> = {};

    for (const r of this.records) {
      const bucket = (Math.round(r.predictedProbability * 10) / 10).toFixed(1);
      if (!buckets[bucket]) buckets[bucket] = { sum: 0, outcomes: 0, count: 0 };
      buckets[bucket]!.sum += r.predictedProbability;
      buckets[bucket]!.outcomes += r.actualOutcome ? 1 : 0;
      buckets[bucket]!.count++;
    }

    const stats: Record<string, { predicted: number; actualRate: number; count: number }> = {};
    for (const [bucket, data] of Object.entries(buckets)) {
      stats[bucket] = {
        predicted: data.sum / data.count,
        actualRate: data.outcomes / data.count,
        count: data.count,
      };
    }
    return stats;
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.logPath)) return;
      const lines = fs.readFileSync(this.logPath, 'utf8').trim().split('\n');
      this.records = lines
        .filter(Boolean)
        .map((l) => {
          const r = JSON.parse(l) as CalibrationRecord;
          r.timestamp = new Date(r.timestamp);
          return r;
        });
      logger.info(`CalibrationTracker: loaded ${this.records.length} records`);
    } catch (err) {
      logger.warn('CalibrationTracker: failed to load from disk', { err });
    }
  }

  private appendToDisk(record: CalibrationRecord): void {
    try {
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    } catch (err) {
      logger.warn('CalibrationTracker: failed to append to disk', { err });
    }
  }
}
