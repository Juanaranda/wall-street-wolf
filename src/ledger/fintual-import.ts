import { Instrument, ManualFill } from '../shared/types';

/** Parsed contents of a Fintual investment confirmation email. */
export interface ParsedFintualEmail {
  action: 'buy' | 'sell';
  company: string;
  shares: number;
  price: number;
  amountUsd: number;
}

/** Parse a Chilean-formatted number: dots = thousands, comma = decimal. */
export function parseChileanNumber(s: string): number | null {
  const n = Number(s.replace(/\s/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function firstNum(text: string, re: RegExp): number | null {
  const m = text.match(re);
  return m && m[1] ? parseChileanNumber(m[1]) : null;
}

/**
 * Parse a Fintual confirmation email (subject + body concatenated) into a
 * structured purchase/sale. Returns null if it isn't a recognizable investment
 * email or required fields can't be extracted.
 */
export function parseFintualEmail(text: string): ParsedFintualEmail | null {
  const isBuy = /invertiste/i.test(text);
  const isSell = /(vendiste|retiraste|rescat)/i.test(text);
  if (!isBuy && !isSell) return null;
  const action: 'buy' | 'sell' = isBuy ? 'buy' : 'sell';

  const companyMatch =
    text.match(/acciones de\s+([^\n\r]+)/i) ||
    text.match(/(?:invertiste|vendiste)[^\n\r]*?\ben\s+([^\n\r]+)/i);
  const company = companyMatch?.[1]?.trim().replace(/[.,;]+$/, '') ?? null;

  let shares =
    firstNum(text, /([\d.,]+)\s+acciones/i) ??
    firstNum(text, /Acciones\s+(?:compradas|vendidas)\s*:?\s*([\d.,]+)/i);
  let price = firstNum(text, /Precio de la acci[oó]n\s*:?\s*US?\s*\$?\s*([\d.,]+)/i);
  let amount =
    firstNum(text, /Monto\s+(?:invertido|vendido)\s*:?\s*US?\s*\$?\s*([\d.,]+)/i) ??
    firstNum(text, /(?:Invertiste|Vendiste)\s*US?\s*\$?\s*([\d.,]+)/i) ??
    firstNum(text, /Costo total\s*:?\s*US?\s*\$?\s*([\d.,]+)/i);

  // Derive any missing piece from the other two.
  if (shares == null && amount != null && price) shares = amount / price;
  if (price == null && amount != null && shares) price = amount / shares;
  if (amount == null && shares != null && price) amount = shares * price;

  if (!company || shares == null || price == null) return null;
  return { action, company, shares, price, amountUsd: amount ?? shares * price };
}

const STOP = new Set([
  'the', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'ltd', 'plc', 'llc', 'sa', 'and', 'class', 'trust', 'group',
]);

function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join(' ');
}

/**
 * Map a Fintual company name to a universe ticker by normalized-name matching.
 * Exact match wins; then containment; then token overlap (Jaccard ≥ 0.5).
 * Returns null when nothing matches confidently.
 */
export function matchTicker(company: string, universe: Instrument[]): string | null {
  const nc = normalizeName(company);
  if (!nc) return null;

  let best: { ticker: string; score: number } | null = null;
  for (const inst of universe) {
    const ni = normalizeName(inst.name);
    if (!ni) continue;

    let score = 0;
    if (nc === ni) score = 1;
    else if (nc.includes(ni) || ni.includes(nc)) score = 0.9;
    else {
      const a = new Set(nc.split(' '));
      const b = new Set(ni.split(' '));
      const inter = [...a].filter((w) => b.has(w)).length;
      const union = new Set([...a, ...b]).size;
      score = union ? inter / union : 0;
    }
    if (score > (best?.score ?? 0)) best = { ticker: inst.ticker, score };
  }
  return best && best.score >= 0.5 ? best.ticker : null;
}

/** Build a ManualFill from a parsed email + resolved ticker. Sells use negative shares. */
export function toManualFill(
  parsed: ParsedFintualEmail,
  ticker: string,
  emailId: string,
  filledAt: Date
): ManualFill {
  return {
    recommendationId: `fintual-${emailId}`,
    ticker,
    filledPrice: parsed.price,
    shares: parsed.action === 'sell' ? -Math.abs(parsed.shares) : Math.abs(parsed.shares),
    filledAt,
  };
}
