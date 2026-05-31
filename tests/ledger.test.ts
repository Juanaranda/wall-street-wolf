import fs from 'fs';
import path from 'path';
import os from 'os';
import { PaperLedger } from '../src/ledger';
import { Recommendation, ManualFill } from '../src/shared/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpPath(): string {
  return path.join(os.tmpdir(), `ledger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

function makeRec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: 'rec-1',
    ticker: 'AAPL',
    action: 'buy',
    suggestedAmountUsd: 500,
    confidence: 0.8,
    rationale: 'Strong momentum',
    createdAt: new Date('2024-01-01T10:00:00Z'),
    ...overrides,
  };
}

function makeFill(overrides: Partial<ManualFill> = {}): ManualFill {
  return {
    recommendationId: 'rec-1',
    ticker: 'AAPL',
    filledPrice: 150,
    shares: 3,
    filledAt: new Date('2024-01-01T12:00:00Z'),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PaperLedger', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpPath();
  });

  afterEach(() => {
    try { fs.unlinkSync(filePath); } catch { /* already absent */ }
  });

  // ── Directory creation ──────────────────────────────────────────────────────

  it('creates the parent directory when it does not exist', () => {
    const nested = path.join(os.tmpdir(), `ledger-dir-${Date.now()}`, 'sub', 'ledger.jsonl');
    const ledger = new PaperLedger(nested);
    ledger.recordRecommendation(makeRec());
    expect(fs.existsSync(nested)).toBe(true);
    // cleanup
    fs.unlinkSync(nested);
    fs.rmdirSync(path.dirname(nested));
    fs.rmdirSync(path.dirname(path.dirname(nested)));
  });

  // ── Append-only JSONL ───────────────────────────────────────────────────────

  it('appends a recommendation event to disk as valid JSON', () => {
    const ledger = new PaperLedger(filePath);
    ledger.recordRecommendation(makeRec());

    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(ev['type']).toBe('recommendation');
    expect(ev['ticker']).toBe('AAPL');
    expect(ev['action']).toBe('buy');
    expect(ev['id']).toBe('rec-1');
  });

  it('appends a fill event to disk as valid JSON', () => {
    const ledger = new PaperLedger(filePath);
    ledger.recordFill(makeFill());

    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(ev['type']).toBe('fill');
    expect(ev['ticker']).toBe('AAPL');
    expect(ev['filledPrice']).toBe(150);
    expect(ev['shares']).toBe(3);
  });

  it('accumulates multiple events across calls', () => {
    const ledger = new PaperLedger(filePath);
    ledger.recordRecommendation(makeRec({ id: 'r1' }));
    ledger.recordRecommendation(makeRec({ id: 'r2', ticker: 'MSFT' }));
    ledger.recordFill(makeFill());

    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
  });

  it('stores dates as ISO strings', () => {
    const ledger = new PaperLedger(filePath);
    const date = new Date('2024-06-15T09:30:00.000Z');
    ledger.recordRecommendation(makeRec({ createdAt: date }));

    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const ev = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(ev['createdAt']).toBe('2024-06-15T09:30:00.000Z');
  });

  // ── Persistence / reload ────────────────────────────────────────────────────

  it('reloads events from disk on construction', () => {
    // Write with first instance.
    const ledger1 = new PaperLedger(filePath);
    ledger1.recordFill(makeFill({ shares: 5, filledPrice: 160 }));

    // Second instance reads the same file.
    const ledger2 = new PaperLedger(filePath);
    const positions = ledger2.openPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.shares).toBe(5);
    expect(positions[0]!.entryPrice).toBeCloseTo(160);
  });

  it('starts empty when the ledger file does not exist', () => {
    const ledger = new PaperLedger(filePath);
    expect(ledger.openPositions()).toEqual([]);
  });

  // ── openPositions reconciliation ────────────────────────────────────────────

  it('returns no open positions when no fills have been recorded', () => {
    const ledger = new PaperLedger(filePath);
    ledger.recordRecommendation(makeRec());
    expect(ledger.openPositions()).toEqual([]);
  });

  it('opens a position on a single buy fill', () => {
    const ledger = new PaperLedger(filePath);
    ledger.recordFill(makeFill({ ticker: 'AAPL', shares: 4, filledPrice: 200 }));

    const positions = ledger.openPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.ticker).toBe('AAPL');
    expect(positions[0]!.shares).toBe(4);
    expect(positions[0]!.entryPrice).toBeCloseTo(200);
  });

  it('averages entry price across multiple buy fills for the same ticker', () => {
    const ledger = new PaperLedger(filePath);
    // Buy 2 shares @ $100 then 2 shares @ $200 → VWAP = $150
    ledger.recordFill(makeFill({ ticker: 'AAPL', shares: 2, filledPrice: 100 }));
    ledger.recordFill(makeFill({ ticker: 'AAPL', shares: 2, filledPrice: 200 }));

    const positions = ledger.openPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.shares).toBe(4);
    expect(positions[0]!.entryPrice).toBeCloseTo(150);
  });

  it('tracks multiple tickers independently', () => {
    const ledger = new PaperLedger(filePath);
    ledger.recordFill(makeFill({ ticker: 'AAPL', shares: 3, filledPrice: 150 }));
    ledger.recordFill(makeFill({ ticker: 'MSFT', shares: 2, filledPrice: 300 }));

    const positions = ledger.openPositions();
    expect(positions).toHaveLength(2);
    const tickers = positions.map((p) => p.ticker).sort();
    expect(tickers).toEqual(['AAPL', 'MSFT']);
  });

  it('closes a position when a sell fill matches all open shares (negative shares convention)', () => {
    const ledger = new PaperLedger(filePath);
    ledger.recordFill(makeFill({ ticker: 'AAPL', shares: 3, filledPrice: 150 }));
    // Sell all 3 shares (negative shares = sell)
    ledger.recordFill(makeFill({ ticker: 'AAPL', shares: -3, filledPrice: 160 }));

    expect(ledger.openPositions()).toEqual([]);
  });

  it('partially closes a position on a partial sell', () => {
    const ledger = new PaperLedger(filePath);
    ledger.recordFill(makeFill({ ticker: 'AAPL', shares: 6, filledPrice: 150 }));
    ledger.recordFill(makeFill({ ticker: 'AAPL', shares: -2, filledPrice: 160 }));

    const positions = ledger.openPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.shares).toBe(4);
  });

  it('preserves openedAt as a Date from the first buy fill', () => {
    const openedAt = new Date('2024-03-01T09:00:00.000Z');
    const ledger = new PaperLedger(filePath);
    ledger.recordFill(makeFill({ ticker: 'AAPL', shares: 2, filledAt: openedAt }));

    const positions = ledger.openPositions();
    expect(positions[0]!.openedAt).toEqual(openedAt);
  });

  it('is idempotent across reloads: replay yields the same positions', () => {
    const ledger1 = new PaperLedger(filePath);
    ledger1.recordRecommendation(makeRec({ id: 'r1', ticker: 'NVDA' }));
    ledger1.recordFill(makeFill({ recommendationId: 'r1', ticker: 'NVDA', shares: 5, filledPrice: 500 }));
    ledger1.recordFill(makeFill({ recommendationId: 'r1', ticker: 'NVDA', shares: -2, filledPrice: 520 }));

    const ledger2 = new PaperLedger(filePath);
    const pos1 = ledger1.openPositions();
    const pos2 = ledger2.openPositions();

    expect(pos2).toHaveLength(pos1.length);
    expect(pos2[0]!.ticker).toBe('NVDA');
    expect(pos2[0]!.shares).toBe(3);
    expect(pos2[0]!.entryPrice).toBeCloseTo(500);
  });
});
