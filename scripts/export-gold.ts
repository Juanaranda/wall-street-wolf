/**
 * Export the GOLD training_examples table to a CSV for ML training.
 * Output: data/gold.csv (gitignored). Run after `npm run etl`.
 *
 * Usage: npm run export-gold
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const COLS = [
  'ticker', 'ts', 'close',
  'ret_1d', 'ret_21d', 'ret_63d', 'ret_126d', 'ret_252d',
  'mom_12_1', 'rsi_14', 'macd_hist', 'ema_gap', 'vol_21', 'dist_252high',
  'fwd_ret', 'label_up', 'split',
];

async function main(): Promise<void> {
  if (!process.env['DATABASE_URL']) {
    console.error('DATABASE_URL not set.');
    process.exit(1);
  }
  const outPath = path.resolve('data/gold.csv');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
  const { rows } = await pool.query(
    `SELECT ${COLS.join(',')} FROM training_examples ORDER BY ts`
  );

  const lines = [COLS.join(',')];
  for (const r of rows as Record<string, unknown>[]) {
    lines.push(
      COLS.map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return '';
        if (v instanceof Date) return v.toISOString();
        if (typeof v === 'boolean') return v ? '1' : '0';
        return String(v);
      }).join(',')
    );
  }
  fs.writeFileSync(outPath, lines.join('\n') + '\n');

  console.log(`Wrote ${rows.length} rows → ${outPath}`);
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('export-gold failed:', err);
  process.exit(1);
});
