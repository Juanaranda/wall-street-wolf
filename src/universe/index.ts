import { Instrument } from '../shared/types';

/**
 * Provides the universe of instruments the system is allowed to recommend.
 * Implementations may load from a static list, a config file, or a remote source.
 */
export interface UniverseProvider {
  list(): Promise<Instrument[]>;
}

/**
 * Seed universe — a small curated set of liquid US instruments buyable in Fintual,
 * including Chilean ADRs/ETF (tagged `chile`). The universe/ agent (issue #2) will
 * expand this and add liquidity filtering.
 */
export const SEED_UNIVERSE: Instrument[] = [
  // Chilean exposure (US-listed ADRs + ETF)
  { ticker: 'SQM', name: 'Sociedad Química y Minera', assetClass: 'adr', tags: ['chile', 'materials'] },
  { ticker: 'BSAC', name: 'Banco Santander Chile', assetClass: 'adr', tags: ['chile', 'financials'] },
  { ticker: 'BCH', name: 'Banco de Chile', assetClass: 'adr', tags: ['chile', 'financials'] },
  { ticker: 'ENIC', name: 'Enel Chile', assetClass: 'adr', tags: ['chile', 'utilities'] },
  { ticker: 'CCU', name: 'Compañía Cervecerías Unidas', assetClass: 'adr', tags: ['chile', 'consumer'] },
  { ticker: 'ECH', name: 'iShares MSCI Chile ETF', assetClass: 'etf', tags: ['chile', 'index'] },
  // Broad US liquidity anchors
  { ticker: 'SPY', name: 'SPDR S&P 500 ETF', assetClass: 'etf', tags: ['us', 'index'] },
  { ticker: 'QQQ', name: 'Invesco QQQ', assetClass: 'etf', tags: ['us', 'index', 'tech'] },
  { ticker: 'AAPL', name: 'Apple Inc.', assetClass: 'stock', tags: ['us', 'tech', 'blue-chip'] },
  { ticker: 'MSFT', name: 'Microsoft Corp.', assetClass: 'stock', tags: ['us', 'tech', 'blue-chip'] },
];

/** Default static universe provider backed by SEED_UNIVERSE. */
export class StaticUniverse implements UniverseProvider {
  constructor(private readonly instruments: Instrument[] = SEED_UNIVERSE) {}

  async list(): Promise<Instrument[]> {
    return this.instruments;
  }
}
