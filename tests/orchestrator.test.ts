import { SignalOrchestrator } from '../src/orchestrator';
import { Instrument, PriceBar, Signal } from '../src/shared/types';
import { UniverseProvider } from '../src/universe';
import { MarketDataProvider } from '../src/data';
import { SignalEngine } from '../src/signals';
import { Notifier } from '../src/notify';
import { Ledger } from '../src/ledger';

jest.mock('../src/shared/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const inst = (ticker: string): Instrument => ({ ticker, name: ticker, assetClass: 'stock', tags: [] });

const universe: UniverseProvider = { list: async () => [inst('AAA'), inst('BBB'), inst('CCC')] };
const data: MarketDataProvider = { getBars: async () => [] as PriceBar[], getLatestPrice: async () => null };

/** Signal per ticker: AAA strong buy, BBB weak buy (filtered), CCC sell (ignored, long-only). */
const engine: SignalEngine = {
  async evaluate(ticker: string): Promise<Signal> {
    const map: Record<string, Signal> = {
      AAA: { ticker, action: 'buy', strength: 0.9, confidence: 0.9, reasons: ['mom'], timestamp: new Date() },
      BBB: { ticker, action: 'buy', strength: 0.4, confidence: 0.4, reasons: ['weak'], timestamp: new Date() },
      CCC: { ticker, action: 'sell', strength: 0.9, confidence: 0.9, reasons: ['down'], timestamp: new Date() },
    };
    return map[ticker]!;
  },
};

describe('SignalOrchestrator.runCycle', () => {
  const sizing = { bankrollUsd: 10000, basePct: 0.05, maxPct: 0.1, minUsd: 50 };

  it('recommends only confident long signals, sizes, notifies, and records them', async () => {
    const notifier: Notifier & { send: jest.Mock } = { send: jest.fn(async () => {}), sendText: jest.fn(async () => {}) };
    const ledger: Ledger & { recordRecommendation: jest.Mock } = {
      recordRecommendation: jest.fn(),
      recordFill: jest.fn(),
      openPositions: () => [],
      getRecommendations: () => [],
      getFills: () => [],
    };

    const orch = new SignalOrchestrator(universe, data, engine, notifier, ledger, sizing);
    const recs = await orch.runCycle();

    // AAA passes (buy); BBB below confidence; CCC is a sell but we don't hold it → ignored.
    expect(recs).toHaveLength(1);
    expect(recs[0]!.ticker).toBe('AAA');
    expect(recs[0]!.action).toBe('buy');
    expect(recs[0]!.suggestedAmountUsd).toBe(475); // conf 0.9 → 4.75% of 10000
    expect(notifier.send).toHaveBeenCalledTimes(1);
    expect(ledger.recordRecommendation).toHaveBeenCalledTimes(1);
  });

  it('emits a SELL to exit a held position whose momentum faded', async () => {
    const notifier: Notifier & { send: jest.Mock } = { send: jest.fn(async () => {}), sendText: jest.fn(async () => {}) };
    const ledger: Ledger = {
      recordRecommendation: jest.fn(),
      recordFill: jest.fn(),
      openPositions: () => [{ ticker: 'CCC', shares: 5, entryPrice: 20, openedAt: new Date() }],
      getRecommendations: () => [],
      getFills: () => [],
    };

    const orch = new SignalOrchestrator(universe, data, engine, notifier, ledger, sizing);
    const recs = await orch.runCycle();

    // We hold CCC and its signal is 'sell' → exit; AAA is still a new buy.
    const sell = recs.find((r) => r.ticker === 'CCC');
    expect(sell).toBeDefined();
    expect(sell!.action).toBe('sell');
    expect(sell!.rationale).toContain('Vender tus 5 acciones');
    expect(recs.find((r) => r.ticker === 'AAA')?.action).toBe('buy');
  });
});
