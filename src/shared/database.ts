/**
 * PostgreSQL database service.
 * Tables are auto-created on first connect (no migration tool needed for this scale).
 *
 * Tables:
 *   predictions     — every prediction the engine makes (win/loss resolved later)
 *   calibration     — resolved outcomes with Brier score
 *
 * Connection uses DATABASE_URL env var (standard Postgres connection string).
 * Falls back gracefully to JSONL if Postgres is unavailable.
 */
import { Pool, PoolClient } from 'pg';
import { logger } from './logger';
import { PredictionResult, ModelVote } from './types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS predictions (
  id              SERIAL PRIMARY KEY,
  market_id       TEXT NOT NULL,
  model_prob      REAL NOT NULL,
  market_prob     REAL NOT NULL,
  edge            REAL NOT NULL,
  confidence      REAL NOT NULL,
  direction       TEXT NOT NULL,
  mispricing_score REAL,
  expected_value  REAL,
  model_votes     JSONB,
  resolved        BOOLEAN DEFAULT FALSE,
  actual_outcome  BOOLEAN,
  brier_score     REAL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS predictions_market_id ON predictions (market_id);
CREATE INDEX IF NOT EXISTS predictions_created_at ON predictions (created_at);
CREATE INDEX IF NOT EXISTS predictions_resolved ON predictions (resolved) WHERE resolved = FALSE;

CREATE TABLE IF NOT EXISTS calibration (
  id                   SERIAL PRIMARY KEY,
  market_id            TEXT NOT NULL,
  predicted_probability REAL NOT NULL,
  actual_outcome       BOOLEAN NOT NULL,
  brier_score          REAL NOT NULL,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);
`;

export class DatabaseService {
  private pool: Pool | null = null;
  private available = false;

  async connect(): Promise<void> {
    const connStr = process.env['DATABASE_URL'];
    if (!connStr) {
      logger.warn('DatabaseService: DATABASE_URL not set — predictions will use JSONL fallback only');
      return;
    }

    try {
      this.pool = new Pool({ connectionString: connStr, max: 5 });
      await this.pool.query(SCHEMA);
      this.available = true;
      logger.info('DatabaseService: connected to PostgreSQL and schema ready');
    } catch (err) {
      logger.warn('DatabaseService: could not connect to PostgreSQL — falling back to JSONL', { err });
      this.pool = null;
      this.available = false;
    }
  }

  get isAvailable(): boolean {
    return this.available;
  }

  /** Insert a new prediction record. Returns the inserted row id (or null on failure). */
  async insertPrediction(result: PredictionResult): Promise<number | null> {
    if (!this.pool) return null;
    try {
      const { rows } = await this.pool.query<{ id: number }>(
        `INSERT INTO predictions
           (market_id, model_prob, market_prob, edge, confidence, direction,
            mispricing_score, expected_value, model_votes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          result.marketId,
          result.modelProbability,
          result.marketProbability,
          result.edge,
          result.confidence,
          result.direction,
          result.mispricingScore,
          result.expectedValue,
          JSON.stringify(result.modelVotes),
        ]
      );
      return rows[0]?.id ?? null;
    } catch (err) {
      logger.warn('DatabaseService: insertPrediction failed', { err });
      return null;
    }
  }

  /** Mark a prediction as resolved with the actual outcome + Brier score. */
  async resolveMarket(marketId: string, outcome: boolean): Promise<void> {
    if (!this.pool) return;
    try {
      // Get the most recent pending prediction for this market
      const { rows } = await this.pool.query<{ id: number; model_prob: number }>(
        `SELECT id, model_prob FROM predictions
         WHERE market_id = $1 AND resolved = FALSE
         ORDER BY created_at DESC LIMIT 1`,
        [marketId]
      );
      if (rows.length === 0) return;

      const row = rows[0]!;
      const brierScore = Math.pow(row.model_prob - (outcome ? 1 : 0), 2);

      await this.pool.query(
        `UPDATE predictions
         SET resolved = TRUE, actual_outcome = $1, brier_score = $2
         WHERE id = $3`,
        [outcome, brierScore, row.id]
      );

      // Also write to calibration table for easy stats queries
      await this.pool.query(
        `INSERT INTO calibration (market_id, predicted_probability, actual_outcome, brier_score)
         VALUES ($1, $2, $3, $4)`,
        [marketId, row.model_prob, outcome, brierScore]
      );

      logger.info('DatabaseService: market resolved', { marketId, outcome, brierScore });
    } catch (err) {
      logger.warn('DatabaseService: resolveMarket failed', { err });
    }
  }

  /** Average Brier score from the calibration table. */
  async averageBrierScore(): Promise<number | null> {
    if (!this.pool) return null;
    try {
      const { rows } = await this.pool.query<{ avg: string }>(
        `SELECT AVG(brier_score)::TEXT AS avg FROM calibration`
      );
      const val = parseFloat(rows[0]?.avg ?? '');
      return isNaN(val) ? null : val;
    } catch {
      return null;
    }
  }

  /** Calibration bucket stats: for each 0.1 probability bucket, what was the actual rate? */
  async calibrationBuckets(): Promise<Array<{
    bucket: number;
    predicted: number;
    actualRate: number;
    count: number;
  }>> {
    if (!this.pool) return [];
    try {
      const { rows } = await this.pool.query<{
        bucket: number;
        avg_predicted: number;
        actual_rate: number;
        count: number;
      }>(`
        SELECT
          ROUND(predicted_probability::NUMERIC, 1)::FLOAT AS bucket,
          AVG(predicted_probability)::FLOAT              AS avg_predicted,
          AVG(actual_outcome::INT)::FLOAT                AS actual_rate,
          COUNT(*)::INT                                  AS count
        FROM calibration
        GROUP BY ROUND(predicted_probability::NUMERIC, 1)
        ORDER BY bucket
      `);
      return rows.map((r) => ({
        bucket: r.bucket,
        predicted: r.avg_predicted,
        actualRate: r.actual_rate,
        count: r.count,
      }));
    } catch {
      return [];
    }
  }

  /** Recent predictions for the dashboard. */
  async recentPredictions(limit = 50): Promise<Array<Record<string, unknown>>> {
    if (!this.pool) return [];
    try {
      const { rows } = await this.pool.query(
        `SELECT * FROM predictions ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
      return rows;
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

// Singleton — import this everywhere
export const db = new DatabaseService();
