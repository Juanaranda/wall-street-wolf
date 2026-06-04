import { Recommendation, ManualFill } from '../shared/types';
import { Ledger } from '../ledger';
import { MarketDataProvider } from '../data';

/** One recommendation evaluated against its (optional) fill and current price. */
export interface ReviewedRecommendation {
  recommendation: Recommendation;
  fill: ManualFill | null;
  currentPrice: number | null;
  /** (currentPrice − fillPrice) / fillPrice, or null if not filled/priced. */
  returnPct: number | null;
  status: 'unfilled' | 'open';
  win: boolean | null;
  lesson: string | null;
}

export interface ConfidenceBucket {
  range: string;
  n: number;
  wins: number;
  winRate: number | null;
  avgReturnPct: number | null;
}

/** Aggregate learning over the system's REAL recommendations (not backtest). */
export interface LearningReport {
  totalRecommendations: number;
  filled: number;
  unfilled: number;
  evaluated: number;
  winRate: number | null;
  avgReturnPct: number | null;
  /** Is the system's stated confidence calibrated on real trades? */
  calibration: ConfidenceBucket[];
  lessons: string[];
}

const BUCKETS: Array<[number, number]> = [
  [0.5, 0.7],
  [0.7, 0.85],
  [0.85, 1.01],
];

/**
 * Closes the learning loop: reviews real recommendations against fills + current
 * prices, measures realized performance and confidence calibration, and distills
 * plain-language lessons. (Survivorship-free: this is the system's ACTUAL track
 * record, the most honest feedback signal there is.)
 */
export class SignalReviewer {
  constructor(
    private readonly ledger: Ledger,
    private readonly data: MarketDataProvider
  ) {}

  async review(): Promise<ReviewedRecommendation[]> {
    const recs = this.ledger.getRecommendations();
    const fillByRec = new Map(this.ledger.getFills().map((f) => [f.recommendationId, f]));

    const out: ReviewedRecommendation[] = [];
    for (const rec of recs) {
      const fill = fillByRec.get(rec.id) ?? null;
      if (!fill) {
        out.push({ recommendation: rec, fill: null, currentPrice: null, returnPct: null, status: 'unfilled', win: null, lesson: 'no ejecutada' });
        continue;
      }
      const currentPrice = await this.data.getLatestPrice(rec.ticker).catch(() => null);
      let returnPct: number | null = null;
      let win: boolean | null = null;
      let lesson: string | null = null;
      if (currentPrice != null && fill.filledPrice > 0) {
        returnPct = (currentPrice - fill.filledPrice) / fill.filledPrice;
        win = returnPct > 0;
        if (!win) {
          lesson = `${rec.ticker}: −${Math.abs(returnPct * 100).toFixed(1)}% desde la compra (confianza ${(rec.confidence * 100).toFixed(0)}%) — el momentum se desvaneció`;
        }
      }
      out.push({ recommendation: rec, fill, currentPrice, returnPct, status: 'open', win, lesson });
    }
    return out;
  }

  async summarize(): Promise<LearningReport> {
    const reviews = await this.review();
    const filled = reviews.filter((r) => r.fill !== null);
    const evaluated = reviews.filter((r) => r.returnPct !== null);
    const wins = evaluated.filter((r) => r.win).length;
    const avg = evaluated.length ? mean(evaluated.map((r) => r.returnPct as number)) : null;

    const calibration: ConfidenceBucket[] = BUCKETS.map(([lo, hi]) => {
      const inB = evaluated.filter((r) => r.recommendation.confidence >= lo && r.recommendation.confidence < hi);
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
      totalRecommendations: reviews.length,
      filled: filled.length,
      unfilled: reviews.length - filled.length,
      evaluated: evaluated.length,
      winRate: evaluated.length ? wins / evaluated.length : null,
      avgReturnPct: avg,
      calibration,
      lessons: this.distill(reviews, evaluated.length, wins, avg),
    };
  }

  private distill(
    reviews: ReviewedRecommendation[],
    evaluated: number,
    wins: number,
    avg: number | null
  ): string[] {
    const lessons: string[] = [];
    if (evaluated === 0) {
      lessons.push('Aún no hay trades evaluables — registra tus fills con `npm run fill` para empezar a aprender.');
      return lessons;
    }
    if (evaluated < 5) {
      lessons.push(`Muestra chica (${evaluated} trades): las conclusiones son tentativas — sigue acumulando historial.`);
    }
    lessons.push(`Track record real: ${wins}/${evaluated} ganadores (${((wins / evaluated) * 100).toFixed(0)}%), retorno medio ${((avg ?? 0) * 100).toFixed(1)}%.`);

    const unfilled = reviews.filter((r) => r.status === 'unfilled').length;
    if (unfilled > 0) lessons.push(`${unfilled} recomendación(es) no ejecutada(s) — registra fills o ignóralas conscientemente.`);

    const losers = reviews.filter((r) => r.win === false);
    if (losers.length > 0) {
      lessons.push(`Perdedores: ${losers.map((l) => l.recommendation.ticker).join(', ')}.`);
    }
    return lessons;
  }
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
