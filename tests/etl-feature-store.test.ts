import { PostgresFeatureStore, QueryRunner } from '../src/etl/feature-store';
import { FeatureRow, TrainingExample } from '../src/etl/features';

jest.mock('../src/shared/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

function fakeRunner(rowCount = 1, rows: unknown[] = []): { runner: QueryRunner; query: jest.Mock } {
  const query = jest.fn().mockResolvedValue({ rows, rowCount });
  return { runner: { query }, query };
}

const feat = (): FeatureRow => ({
  ticker: 'AAA', ts: new Date('2020-01-02'), close: 100,
  ret_1d: 0.01, ret_21d: 0.05, ret_63d: 0.1, ret_126d: 0.2, ret_252d: 0.3,
  mom_12_1: 0.25, rsi_14: 55, macd_hist: 0.3, ema_gap: 0.02, vol_21: 0.015, dist_252high: -0.03,
});

describe('PostgresFeatureStore', () => {
  it('upserts features with ON CONFLICT and correct param count', async () => {
    const { runner, query } = fakeRunner(2);
    const store = new PostgresFeatureStore(undefined, runner);
    const n = await store.upsertFeatures([feat(), feat()]);

    // First call ensures schema, second is the insert.
    const insert = query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO features'));
    expect(insert).toBeDefined();
    expect(String(insert![0])).toContain('ON CONFLICT (ticker, ts) DO UPDATE');
    // 14 columns × 2 rows = 28 params.
    expect((insert![1] as unknown[]).length).toBe(28);
    expect(n).toBe(2);
  });

  it('upserts training examples including label columns', async () => {
    const { runner, query } = fakeRunner(1);
    const store = new PostgresFeatureStore(undefined, runner);
    const ex: TrainingExample = { ...feat(), fwd_ret: 0.04, label_up: true, split: 'train' };
    await store.upsertTrainingExamples([ex]);

    const insert = query.mock.calls.find((c) => String(c[0]).startsWith('INSERT INTO training_examples'));
    expect(insert).toBeDefined();
    // 14 feature/base cols + fwd_ret + label_up + split = 17 params for 1 row.
    expect((insert![1] as unknown[]).length).toBe(17);
  });

  it('returns 0 on empty input without querying', async () => {
    const { runner, query } = fakeRunner();
    const store = new PostgresFeatureStore(undefined, runner);
    expect(await store.upsertFeatures([])).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('count(train) filters by split', async () => {
    const { runner, query } = fakeRunner(1, [{ n: 42 }]);
    const store = new PostgresFeatureStore(undefined, runner);
    const n = await store.count('training_examples', 'train');
    const call = query.mock.calls.find((c) => String(c[0]).includes('COUNT(*)'));
    expect(String(call![0])).toContain('WHERE split=$1');
    expect(call![1]).toEqual(['train']);
    expect(n).toBe(42);
  });

  it('never throws on DB error', async () => {
    const runner: QueryRunner = { query: jest.fn().mockRejectedValue(new Error('db down')) };
    const store = new PostgresFeatureStore(undefined, runner);
    expect(await store.upsertFeatures([feat()])).toBe(0);
  });
});
