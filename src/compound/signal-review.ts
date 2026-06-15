import { Ledger } from '../ledger';
import { MarketDataProvider } from '../data';
import { buildPortfolio } from './portfolio';

/** One real holding evaluated at the current price (the actual track record). */
export interface ReviewedPosition {
  ticker: string;
  shares: number;
  entryPrice: number;
  currentPrice: number | null;
  costUsd: number;
  valueUsd: number | null;
  returnPct: number | null;
  win: boolean | null;
  /** Confidence of the most recent recommendation for this ticker, if any. */
  confidence: number | null;
  lesson: string | null;
}

export interface ConfidenceBucket {
  range: string;
  n: number;
  wins: number;
  winRate: number | null;
  avgReturnPct: number | null;
}

/** Aggregate learning over the user's REAL positions (survivorship-free). */
export interface LearningReport {
  positions: number;
  evaluated: number;
  winRate: number | null;
  avgReturnPct: number | null;
  totalPnlUsd: number;
  recommendationsOnRecord: number;
  calibration: ConfidenceBucket[];
  lessons: string[];
}

const BUCKETS: Array<[number, number]> = [
  [0.5, 0.7],
  [0.7, 0.85],
  [0.85, 1.01],
];

/**
 * Closes the learning loop using ACTUAL positions (from imported fills), valued at
 * current prices — not by matching recommendation IDs (imported fills don't carry
 * the original recommendation id). Confidence for calibration is attached from the
 * most recent recommendation per ticker.
 */
export class SignalReviewer {
  constructor(
    private readonly ledger: Ledger,
    private readonly data: MarketDataProvider
  ) {}

  /** Latest recommendation confidence per ticker (for calibration). */
  private confidenceByTicker(): Map<string, number> {
    const map = new Map<string, number>();
    const recs = [...this.ledger.getRecommendations()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
    );
    for (const r of recs) map.set(r.ticker, r.confidence); // last wins
    return map;
  }

  async review(): Promise<ReviewedPosition[]> {
    const portfolio = await buildPortfolio(this.ledger, this.data);
    const confByTicker = this.confidenceByTicker();

    return portfolio.holdings.map((h) => {
      const win = h.pnlPct === null ? null : h.pnlPct > 0;
      const lesson =
        win === false
          ? `${h.ticker}: ${(h.pnlPct! * 100).toFixed(1)}% desde la compra — vigilar el momentum`
          : null;
      return {
        ticker: h.ticker,
        shares: h.shares,
        entryPrice: h.entryPrice,
        currentPrice: h.currentPrice,
        costUsd: h.costUsd,
        valueUsd: h.valueUsd,
        returnPct: h.pnlPct,
        win,
        confidence: confByTicker.get(h.ticker) ?? null,
        lesson,
      };
    });
  }

  async summarize(): Promise<LearningReport> {
    const reviews = await this.review();
    const evaluated = reviews.filter((r) => r.returnPct !== null);
    const wins = evaluated.filter((r) => r.win).length;
    const avg = evaluated.length ? mean(evaluated.map((r) => r.returnPct as number)) : null;
    const totalPnlUsd = reviews.reduce(
      (s, r) => s + (r.valueUsd !== null ? r.valueUsd - r.costUsd : 0),
      0
    );

    const calibration: ConfidenceBucket[] = BUCKETS.map(([lo, hi]) => {
      const inB = evaluated.filter((r) => r.confidence !== null && r.confidence >= lo && r.confidence < hi);
      const w = inB.filter((r) => r.win).length;
      return {
        range: `${lo.toFixed(2)}–${hi >= 1 ? '1.00' : hi.toFixed(2)}`,
        n: inB.length,
        wins: w,
        winRate: inB.length ? w / inB.length : null,
        avgReturnPct: inB.length ? mean(inB.map((r) => r.returnPct as number)) : null,
      };
    });

    return {
      positions: reviews.length,
      evaluated: evaluated.length,
      winRate: evaluated.length ? wins / evaluated.length : null,
      avgReturnPct: avg,
      totalPnlUsd,
      recommendationsOnRecord: this.ledger.getRecommendations().length,
      calibration,
      lessons: this.distill(reviews, evaluated.length, wins, avg, totalPnlUsd),
    };
  }

  private distill(
    reviews: ReviewedPosition[],
    evaluated: number,
    wins: number,
    avg: number | null,
    totalPnlUsd: number
  ): string[] {
    const lessons: string[] = [];
    if (reviews.length === 0) {
      lessons.push('Aún no tienes posiciones — corre `npm run import-fintual` para traer tus compras.');
      return lessons;
    }
    if (evaluated < 5) {
      lessons.push(`Muestra chica (${evaluated} posiciones): conclusiones tentativas — sigue acumulando historial.`);
    }
    lessons.push(
      `Cartera: ${reviews.length} posiciones, ${wins}/${evaluated} en verde, retorno medio ${((avg ?? 0) * 100).toFixed(1)}%, P&L US$${totalPnlUsd.toFixed(2)}.`
    );
    const losers = reviews.filter((r) => r.win === false);
    if (losers.length > 0) lessons.push(`En rojo: ${losers.map((l) => l.ticker).join(', ')}.`);
    return lessons;
  }
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
