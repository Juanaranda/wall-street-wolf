import * as fs from 'fs';
import * as path from 'path';

import { Instrument } from '../shared/types';
import { logger } from '../shared/logger';

/**
 * Provides the universe of instruments the system is allowed to recommend.
 * Implementations may load from a static list, a config file, or a remote source.
 */
export interface UniverseProvider {
  list(): Promise<Instrument[]>;
}

/**
 * Seed universe — a broad curated set of liquid US instruments buyable in Fintual,
 * including Chilean ADRs/ETF (tagged `chile`).
 */
export const SEED_UNIVERSE: Instrument[] = [
  // ── Chilean exposure (US-listed ADRs + ETF) ───────────────────────────────
  { ticker: 'SQM',   name: 'Sociedad Química y Minera',      assetClass: 'adr',   tags: ['chile', 'materials'] },
  { ticker: 'BSAC',  name: 'Banco Santander Chile',           assetClass: 'adr',   tags: ['chile', 'financials'] },
  { ticker: 'BCH',   name: 'Banco de Chile',                  assetClass: 'adr',   tags: ['chile', 'financials'] },
  { ticker: 'ENIC',  name: 'Enel Chile',                      assetClass: 'adr',   tags: ['chile', 'utilities'] },
  { ticker: 'CCU',   name: 'Compañía Cervecerías Unidas',     assetClass: 'adr',   tags: ['chile', 'consumer'] },
  { ticker: 'ECH',   name: 'iShares MSCI Chile ETF',          assetClass: 'etf',   tags: ['chile', 'index'] },

  // ── Broad-market ETFs ──────────────────────────────────────────────────────
  { ticker: 'SPY',   name: 'SPDR S&P 500 ETF',               assetClass: 'etf',   tags: ['us', 'index'] },
  { ticker: 'QQQ',   name: 'Invesco QQQ Trust',               assetClass: 'etf',   tags: ['us', 'index', 'tech'] },
  { ticker: 'DIA',   name: 'SPDR Dow Jones Industrial ETF',   assetClass: 'etf',   tags: ['us', 'index'] },
  { ticker: 'IWM',   name: 'iShares Russell 2000 ETF',        assetClass: 'etf',   tags: ['us', 'index', 'small-cap'] },
  { ticker: 'VTI',   name: 'Vanguard Total Stock Market ETF', assetClass: 'etf',   tags: ['us', 'index'] },
  { ticker: 'VOO',   name: 'Vanguard S&P 500 ETF',            assetClass: 'etf',   tags: ['us', 'index'] },
  { ticker: 'GLD',   name: 'SPDR Gold Shares ETF',            assetClass: 'etf',   tags: ['us', 'commodities', 'gold'] },
  { ticker: 'XLF',   name: 'Financial Select Sector SPDR',    assetClass: 'etf',   tags: ['us', 'financials'] },
  { ticker: 'XLK',   name: 'Technology Select Sector SPDR',   assetClass: 'etf',   tags: ['us', 'tech'] },
  { ticker: 'XLE',   name: 'Energy Select Sector SPDR',       assetClass: 'etf',   tags: ['us', 'energy'] },
  { ticker: 'XLV',   name: 'Health Care Select Sector SPDR',  assetClass: 'etf',   tags: ['us', 'healthcare'] },

  // ── Technology ─────────────────────────────────────────────────────────────
  { ticker: 'AAPL',  name: 'Apple Inc.',                      assetClass: 'stock', tags: ['us', 'tech', 'blue-chip'] },
  { ticker: 'MSFT',  name: 'Microsoft Corp.',                 assetClass: 'stock', tags: ['us', 'tech', 'blue-chip'] },
  { ticker: 'NVDA',  name: 'NVIDIA Corp.',                    assetClass: 'stock', tags: ['us', 'tech', 'blue-chip'] },
  { ticker: 'GOOGL', name: 'Alphabet Inc. Class A',           assetClass: 'stock', tags: ['us', 'tech', 'blue-chip'] },
  { ticker: 'AMZN',  name: 'Amazon.com Inc.',                 assetClass: 'stock', tags: ['us', 'tech', 'blue-chip', 'consumer'] },
  { ticker: 'META',  name: 'Meta Platforms Inc.',             assetClass: 'stock', tags: ['us', 'tech', 'blue-chip'] },
  { ticker: 'TSLA',  name: 'Tesla Inc.',                      assetClass: 'stock', tags: ['us', 'tech', 'consumer', 'ev'] },
  { ticker: 'AVGO',  name: 'Broadcom Inc.',                   assetClass: 'stock', tags: ['us', 'tech', 'semiconductors'] },
  { ticker: 'ORCL',  name: 'Oracle Corp.',                    assetClass: 'stock', tags: ['us', 'tech'] },
  { ticker: 'CRM',   name: 'Salesforce Inc.',                 assetClass: 'stock', tags: ['us', 'tech', 'saas'] },
  { ticker: 'AMD',   name: 'Advanced Micro Devices Inc.',     assetClass: 'stock', tags: ['us', 'tech', 'semiconductors'] },
  { ticker: 'INTC',  name: 'Intel Corp.',                     assetClass: 'stock', tags: ['us', 'tech', 'semiconductors'] },

  // ── Financials ─────────────────────────────────────────────────────────────
  { ticker: 'JPM',   name: 'JPMorgan Chase & Co.',            assetClass: 'stock', tags: ['us', 'financials', 'blue-chip'] },
  { ticker: 'BAC',   name: 'Bank of America Corp.',           assetClass: 'stock', tags: ['us', 'financials'] },
  { ticker: 'WFC',   name: 'Wells Fargo & Co.',               assetClass: 'stock', tags: ['us', 'financials'] },
  { ticker: 'GS',    name: 'Goldman Sachs Group Inc.',        assetClass: 'stock', tags: ['us', 'financials'] },
  { ticker: 'MS',    name: 'Morgan Stanley',                  assetClass: 'stock', tags: ['us', 'financials'] },
  { ticker: 'V',     name: 'Visa Inc.',                       assetClass: 'stock', tags: ['us', 'financials', 'blue-chip'] },
  { ticker: 'MA',    name: 'Mastercard Inc.',                 assetClass: 'stock', tags: ['us', 'financials', 'blue-chip'] },
  { ticker: 'BRK-B', name: 'Berkshire Hathaway Inc. Class B', assetClass: 'stock', tags: ['us', 'financials', 'blue-chip', 'conglomerate'] },

  // ── Healthcare ─────────────────────────────────────────────────────────────
  { ticker: 'JNJ',   name: 'Johnson & Johnson',               assetClass: 'stock', tags: ['us', 'healthcare', 'blue-chip'] },
  { ticker: 'UNH',   name: 'UnitedHealth Group Inc.',         assetClass: 'stock', tags: ['us', 'healthcare'] },
  { ticker: 'LLY',   name: 'Eli Lilly and Co.',               assetClass: 'stock', tags: ['us', 'healthcare', 'pharma'] },
  { ticker: 'ABBV',  name: 'AbbVie Inc.',                     assetClass: 'stock', tags: ['us', 'healthcare', 'pharma'] },
  { ticker: 'MRK',   name: 'Merck & Co. Inc.',                assetClass: 'stock', tags: ['us', 'healthcare', 'pharma'] },
  { ticker: 'PFE',   name: 'Pfizer Inc.',                     assetClass: 'stock', tags: ['us', 'healthcare', 'pharma'] },

  // ── Energy ─────────────────────────────────────────────────────────────────
  { ticker: 'XOM',   name: 'Exxon Mobil Corp.',               assetClass: 'stock', tags: ['us', 'energy', 'blue-chip'] },
  { ticker: 'CVX',   name: 'Chevron Corp.',                   assetClass: 'stock', tags: ['us', 'energy', 'blue-chip'] },
  { ticker: 'COP',   name: 'ConocoPhillips',                  assetClass: 'stock', tags: ['us', 'energy'] },

  // ── Consumer ───────────────────────────────────────────────────────────────
  { ticker: 'WMT',   name: 'Walmart Inc.',                    assetClass: 'stock', tags: ['us', 'consumer', 'blue-chip'] },
  { ticker: 'HD',    name: 'The Home Depot Inc.',             assetClass: 'stock', tags: ['us', 'consumer', 'blue-chip'] },
  { ticker: 'COST',  name: 'Costco Wholesale Corp.',          assetClass: 'stock', tags: ['us', 'consumer'] },
  { ticker: 'PG',    name: 'Procter & Gamble Co.',            assetClass: 'stock', tags: ['us', 'consumer', 'blue-chip'] },
  { ticker: 'KO',    name: 'The Coca-Cola Co.',               assetClass: 'stock', tags: ['us', 'consumer', 'blue-chip'] },

  // ── Industrials ────────────────────────────────────────────────────────────
  { ticker: 'CAT',   name: 'Caterpillar Inc.',                assetClass: 'stock', tags: ['us', 'industrials'] },
  { ticker: 'RTX',   name: 'RTX Corp.',                       assetClass: 'stock', tags: ['us', 'industrials', 'defense'] },
  { ticker: 'UNP',   name: 'Union Pacific Corp.',             assetClass: 'stock', tags: ['us', 'industrials', 'transportation'] },
];

/**
 * Filter an instrument list by a single tag.
 * Returns every instrument whose `tags` array contains the given tag.
 */
export function byTag(tag: string, instruments: Instrument[] = SEED_UNIVERSE): Instrument[] {
  return instruments.filter((i) => i.tags.includes(tag));
}

/** Default static universe provider backed by SEED_UNIVERSE. */
export class StaticUniverse implements UniverseProvider {
  constructor(private readonly instruments: Instrument[] = SEED_UNIVERSE) {}

  async list(): Promise<Instrument[]> {
    return this.instruments;
  }
}

/**
 * File-backed universe provider.
 * Loads instruments from a JSON file at `filePath`.
 * Falls back to `SEED_UNIVERSE` if the file does not exist or cannot be parsed.
 */
export class FileUniverse implements UniverseProvider {
  private readonly filePath: string;

  constructor(filePath: string = path.join(process.cwd(), 'config', 'universe.json')) {
    this.filePath = filePath;
  }

  async list(): Promise<Instrument[]> {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        logger.warn('[FileUniverse] universe.json did not contain an array — falling back to SEED_UNIVERSE');
        return SEED_UNIVERSE;
      }
      return parsed as Instrument[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[FileUniverse] Could not load universe file "${this.filePath}" (${msg}) — falling back to SEED_UNIVERSE`);
      return SEED_UNIVERSE;
    }
  }
}
