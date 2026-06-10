import { parseFintualEmail, parseChileanNumber, matchTicker, toManualFill } from '../src/ledger/fintual-import';
import { Instrument } from '../src/shared/types';

const universe: Instrument[] = [
  { ticker: 'UNH', name: 'UnitedHealth Group Inc.', assetClass: 'stock', tags: [] },
  { ticker: 'CAT', name: 'Caterpillar Inc.', assetClass: 'stock', tags: [] },
  { ticker: 'GS', name: 'Goldman Sachs Group Inc.', assetClass: 'stock', tags: [] },
  { ticker: 'MRK', name: 'Merck & Co. Inc.', assetClass: 'stock', tags: [] },
  { ticker: 'KO', name: 'The Coca-Cola Co.', assetClass: 'stock', tags: [] },
];

// The user's real email (subject + body concatenated).
const REAL_EMAIL = `Invertiste US $9,00 dólares en 0,021686746 acciones de UnitedHealth Group Incorporated
Hola Juan
Invertiste 9,00 de tus dólares en UnitedHealth Group Incorporated
Monto invertido US $ 9,00
Precio de la acción US $ 415,00
Acciones compradas 0,021686746
Comisión US $ 0,00
Costo total US $ 9,00`;

describe('parseChileanNumber', () => {
  it('parses comma decimals and dot thousands', () => {
    expect(parseChileanNumber('9,00')).toBeCloseTo(9, 6);
    expect(parseChileanNumber('0,021686746')).toBeCloseTo(0.021686746, 9);
    expect(parseChileanNumber('1.032,01')).toBeCloseTo(1032.01, 2);
    expect(parseChileanNumber('415,00')).toBeCloseTo(415, 2);
  });
});

describe('parseFintualEmail', () => {
  it('parses the real Fintual buy email', () => {
    const p = parseFintualEmail(REAL_EMAIL)!;
    expect(p.action).toBe('buy');
    expect(p.company).toContain('UnitedHealth');
    expect(p.shares).toBeCloseTo(0.021686746, 9);
    expect(p.price).toBeCloseTo(415, 2);
    expect(p.amountUsd).toBeCloseTo(9, 2);
  });

  it('returns null for a non-investment email', () => {
    expect(parseFintualEmail('Hola, tu resumen mensual está listo')).toBeNull();
  });

  it('derives shares from amount/price when shares are missing', () => {
    const p = parseFintualEmail('Invertiste US $10,00 en Caterpillar Inc.\nPrecio de la acción US $ 100,00')!;
    expect(p.shares).toBeCloseTo(0.1, 6);
  });
});

describe('matchTicker', () => {
  it('matches despite legal-suffix differences', () => {
    expect(matchTicker('UnitedHealth Group Incorporated', universe)).toBe('UNH');
    expect(matchTicker('Caterpillar Inc.', universe)).toBe('CAT');
    expect(matchTicker('The Goldman Sachs Group, Inc.', universe)).toBe('GS');
    expect(matchTicker('Merck & Co., Inc.', universe)).toBe('MRK');
    expect(matchTicker('The Coca-Cola Company', universe)).toBe('KO');
  });

  it('returns null for an unknown company', () => {
    expect(matchTicker('Some Random Startup LLC', universe)).toBeNull();
  });
});

describe('toManualFill', () => {
  it('builds an idempotent buy fill', () => {
    const p = parseFintualEmail(REAL_EMAIL)!;
    const f = toManualFill(p, 'UNH', 'abc123', new Date('2026-06-09'));
    expect(f.recommendationId).toBe('fintual-abc123');
    expect(f.ticker).toBe('UNH');
    expect(f.shares).toBeCloseTo(0.021686746, 9);
    expect(f.filledPrice).toBeCloseTo(415, 2);
  });

  it('records sells as negative shares', () => {
    const p = { action: 'sell' as const, company: 'Caterpillar Inc.', shares: 0.02, price: 900, amountUsd: 18 };
    const f = toManualFill(p, 'CAT', 'sell1', new Date());
    expect(f.shares).toBe(-0.02);
  });
});
