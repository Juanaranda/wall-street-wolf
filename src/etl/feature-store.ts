import { Pool } from 'pg';
import { logger } from '../shared/logger';
import { FeatureRow, TrainingExample } from './features';

/** Minimal query interface so tests can inject a mock instead of a real pg Pool. */
export interface QueryRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** Feature columns persisted in both the silver (`features`) and gold tables. */
const FEATURE_COLS = [
  'ret_1d', 'ret_21d', 'ret_63d', 'ret_126d', 'ret_252d',
  'mom_12_1', 'rsi_14', 'macd_hist', 'ema_gap', 'vol_21', 'dist_252high',
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS features (
  ticker TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, close DOUBLE PRECISION,
  ${FEATURE_COLS.map((c) => `${c} DOUBLE PRECISION`).join(', ')},
  PRIMARY KEY (ticker, ts)
);
CREATE INDEX IF NOT EXISTS features_ts ON features (ts);

CREATE TABLE IF NOT EXISTS training_examples (
  ticker TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL, close DOUBLE PRECISION,
  ${FEATURE_COLS.map((c) => `${c} DOUBLE PRECISION`).join(', ')},
  fwd_ret DOUBLE PRECISION, label_up BOOLEAN, split TEXT,
  PRIMARY KEY (ticker, ts)
);
CREATE INDEX IF NOT EXISTS training_split ON training_examples (split);
`;

const CHUNK = 500;

/**
 * GOLD/SILVER store. Persists computed features and labelled training examples
 * to Postgres for fast ML/analysis queries. Idempotent upserts; never throws.
 */
export class PostgresFeatureStore {
  private readonly pool: QueryRunner;
  private schemaReady = false;

  constructor(connectionString?: string, poolOverride?: QueryRunner) {
    this.pool =
      poolOverride ??
      (new Pool(
        (connectionString ?? process.env['DATABASE_URL'])
          ? { connectionString: connectionString ?? process.env['DATABASE_URL'] }
          : undefined
      ) as unknown as QueryRunner);
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await this.pool.query(SCHEMA);
    this.schemaReady = true;
  }

  /** Upsert silver feature rows. Returns count written. */
  async upsertFeatures(rows: FeatureRow[]): Promise<number> {
    return this.upsert('features', rows, (r) => [r.ticker, r.ts, r.close, ...FEATURE_COLS.map((c) => r[c])]);
  }

  /** Upsert gold training examples. Returns count written. */
  async upsertTrainingExamples(rows: TrainingExample[]): Promise<number> {
    return this.upsert(
      'training_examples',
      rows,
      (r) => [r.ticker, r.ts, r.close, ...FEATURE_COLS.map((c) => r[c]), r.fwd_ret, r.label_up, r.split]
    );
  }

  private async upsert<T>(
    table: 'features' | 'training_examples',
    rows: T[],
    toParams: (row: T) => unknown[]
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const cols =
      table === 'features'
        ? ['ticker', 'ts', 'close', ...FEATURE_COLS]
        : ['ticker', 'ts', 'close', ...FEATURE_COLS, 'fwd_ret', 'label_up', 'split'];
    const updateCols = cols.filter((c) => c !== 'ticker' && c !== 'ts');

    try {
      await this.ensureSchema();
      let written = 0;
      for (let start = 0; start < rows.length; start += CHUNK) {
        const chunk = rows.slice(start, start + CHUNK);
        const values: string[] = [];
        const params: unknown[] = [];
        chunk.forEach((row, r) => {
          const ph = cols.map((_, c) => `$${r * cols.length + c + 1}`);
          values.push(`(${ph.join(',')})`);
          params.push(...toParams(row));
        });
        const sql =
          `INSERT INTO ${table} (${cols.join(',')}) VALUES ${values.join(',')} ` +
          `ON CONFLICT (ticker, ts) DO UPDATE SET ${updateCols.map((c) => `${c}=EXCLUDED.${c}`).join(',')}`;
        const res = await this.pool.query(sql, params);
        written += res.rowCount ?? chunk.length;
      }
      return written;
    } catch (err) {
      logger.error(`PostgresFeatureStore.upsert(${table}) failed`, { err });
      return 0;
    }
  }

  /** Count rows in a table for a given split (training_examples) or all. */
  async count(table: 'features' | 'training_examples', split?: 'train' | 'test'): Promise<number> {
    try {
      await this.ensureSchema();
      const res =
        split && table === 'training_examples'
          ? await this.pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE split=$1`, [split])
          : await this.pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
      return (res.rows[0] as { n: number } | undefined)?.n ?? 0;
    } catch (err) {
      logger.error(`PostgresFeatureStore.count(${table}) failed`, { err });
      return 0;
    }
  }
}
