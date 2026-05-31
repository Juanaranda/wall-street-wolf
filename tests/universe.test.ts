import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SEED_UNIVERSE, StaticUniverse, FileUniverse, byTag } from '../src/universe/index';
import type { Instrument } from '../src/shared/types';

// ── helpers ────────────────────────────────────────────────────────────────────

function writeTempJson(data: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'universe-test-'));
  const file = path.join(dir, 'universe.json');
  fs.writeFileSync(file, JSON.stringify(data), 'utf-8');
  return file;
}

// ── SEED_UNIVERSE integrity ────────────────────────────────────────────────────

describe('SEED_UNIVERSE integrity', () => {
  it('contains at least 40 instruments', () => {
    expect(SEED_UNIVERSE.length).toBeGreaterThanOrEqual(40);
  });

  it('contains no duplicate tickers', () => {
    const tickers = SEED_UNIVERSE.map((i) => i.ticker);
    const unique = new Set(tickers);
    expect(unique.size).toBe(tickers.length);
  });

  it('every instrument has a non-empty ticker, name, and assetClass', () => {
    for (const inst of SEED_UNIVERSE) {
      expect(inst.ticker.trim().length).toBeGreaterThan(0);
      expect(inst.name.trim().length).toBeGreaterThan(0);
      expect(['stock', 'etf', 'adr']).toContain(inst.assetClass);
    }
  });

  it('every instrument has a non-empty tags array', () => {
    for (const inst of SEED_UNIVERSE) {
      expect(Array.isArray(inst.tags)).toBe(true);
      expect(inst.tags.length).toBeGreaterThan(0);
    }
  });

  it('includes all required Chilean tickers', () => {
    const tickers = new Set(SEED_UNIVERSE.map((i) => i.ticker));
    for (const required of ['SQM', 'BSAC', 'BCH', 'ENIC', 'CCU', 'ECH']) {
      expect(tickers.has(required)).toBe(true);
    }
  });

  it('includes the core ETFs: SPY, QQQ, DIA, IWM', () => {
    const tickers = new Set(SEED_UNIVERSE.map((i) => i.ticker));
    for (const required of ['SPY', 'QQQ', 'DIA', 'IWM']) {
      expect(tickers.has(required)).toBe(true);
    }
  });

  it('Chilean tickers are tagged chile', () => {
    const chileTickers = ['SQM', 'BSAC', 'BCH', 'ENIC', 'CCU', 'ECH'];
    for (const ticker of chileTickers) {
      const inst = SEED_UNIVERSE.find((i) => i.ticker === ticker);
      expect(inst).toBeDefined();
      expect(inst!.tags).toContain('chile');
    }
  });
});

// ── byTag filtering ────────────────────────────────────────────────────────────

describe('byTag helper', () => {
  it('returns only instruments tagged chile', () => {
    const results = byTag('chile');
    expect(results.length).toBeGreaterThanOrEqual(6);
    for (const inst of results) {
      expect(inst.tags).toContain('chile');
    }
  });

  it('returns nothing for an unknown tag', () => {
    expect(byTag('__nonexistent__')).toHaveLength(0);
  });

  it('operates on a provided list, not always SEED_UNIVERSE', () => {
    const custom: Instrument[] = [
      { ticker: 'FOO', name: 'Foo Corp',  assetClass: 'stock', tags: ['alpha'] },
      { ticker: 'BAR', name: 'Bar Corp',  assetClass: 'stock', tags: ['beta'] },
      { ticker: 'BAZ', name: 'Baz Corp',  assetClass: 'etf',   tags: ['alpha', 'beta'] },
    ];
    const alphaResults = byTag('alpha', custom);
    expect(alphaResults).toHaveLength(2);
    expect(alphaResults.map((i) => i.ticker)).toEqual(expect.arrayContaining(['FOO', 'BAZ']));
  });
});

// ── StaticUniverse ─────────────────────────────────────────────────────────────

describe('StaticUniverse', () => {
  it('returns the full SEED_UNIVERSE by default', async () => {
    const provider = new StaticUniverse();
    const result = await provider.list();
    expect(result).toEqual(SEED_UNIVERSE);
  });

  it('accepts a custom instrument list', async () => {
    const custom: Instrument[] = [
      { ticker: 'TEST', name: 'Test Corp', assetClass: 'stock', tags: ['test'] },
    ];
    const provider = new StaticUniverse(custom);
    const result = await provider.list();
    expect(result).toEqual(custom);
  });
});

// ── FileUniverse ───────────────────────────────────────────────────────────────

describe('FileUniverse', () => {
  it('loads instruments from a valid JSON file', async () => {
    const data: Instrument[] = [
      { ticker: 'ATEST', name: 'A Test ETF', assetClass: 'etf', tags: ['test'] },
      { ticker: 'BTEST', name: 'B Test Stock', assetClass: 'stock', tags: ['test', 'us'] },
    ];
    const filePath = writeTempJson(data);

    const provider = new FileUniverse(filePath);
    const result = await provider.list();
    expect(result).toHaveLength(2);
    expect(result[0].ticker).toBe('ATEST');
    expect(result[1].ticker).toBe('BTEST');

    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('falls back to SEED_UNIVERSE when the file does not exist', async () => {
    const provider = new FileUniverse('/nonexistent/path/universe.json');
    const result = await provider.list();
    expect(result).toEqual(SEED_UNIVERSE);
  });

  it('falls back to SEED_UNIVERSE when the file contains invalid JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'universe-bad-'));
    const file = path.join(dir, 'universe.json');
    fs.writeFileSync(file, '{ not valid json }', 'utf-8');

    const provider = new FileUniverse(file);
    const result = await provider.list();
    expect(result).toEqual(SEED_UNIVERSE);

    fs.rmSync(dir, { recursive: true });
  });

  it('falls back to SEED_UNIVERSE when JSON is not an array', async () => {
    const filePath = writeTempJson({ instruments: [] });

    const provider = new FileUniverse(filePath);
    const result = await provider.list();
    expect(result).toEqual(SEED_UNIVERSE);

    fs.rmSync(path.dirname(filePath), { recursive: true });
  });

  it('defaults to config/universe.json in the working directory', () => {
    // Just verify the default path includes "config/universe.json" without
    // actually loading the file (cwd may differ in CI); constructor is sync.
    const provider = new FileUniverse();
    // Access via bracket notation to inspect private field in tests
    const fp: string = (provider as unknown as { filePath: string }).filePath;
    expect(fp.endsWith(path.join('config', 'universe.json'))).toBe(true);
  });
});
