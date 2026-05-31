import { execFile } from 'child_process';
import path from 'path';
import { logger } from '../shared/logger';
import { ResearchBrief, MarketSignal } from '../shared/types';

function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

const PREDICT_SCRIPT = path.resolve('./scripts/predict_xgboost.py');
const MODEL_PATH = path.resolve('./data/xgboost_model.json');

/** Minimum edge from XGBoost required to proceed to LLM ensemble */
export const XGBOOST_GATE_THRESHOLD = 0.02;

export interface FastModelInput {
  marketPrice: number;
  daysToExpiry: number;
  volume24h: number;
  totalLiquidity: number;
  sentimentScore: number;
  volumeSpike: number;
  spreadWidth: number;
  anomalyScore: number;
  sourceCount: number;
  sentimentConfidence: number;
  estimatedEdge: number;
  category: string;
}

export interface FastModelResult {
  probability: number;
  edge: number;
  marketPrice: number;
  usedFallback: boolean;
  hasModel: boolean;
  passesGate: boolean;   // true if |edge| >= XGBOOST_GATE_THRESHOLD
  latencyMs: number;
}

export class XGBoostFastModel {
  /**
   * Run XGBoost inference synchronously via Python subprocess.
   * Typical latency: 30–80ms (model already on disk, Python cold start dominates).
   * Use a long-running Python service for true <10ms if needed in production.
   */
  async predict(input: FastModelInput): Promise<FastModelResult> {
    const start = Date.now();

    const payload = {
      market_price: input.marketPrice,
      days_to_expiry: input.daysToExpiry,
      volume_24h: input.volume24h,
      total_liquidity: input.totalLiquidity,
      sentiment_score: input.sentimentScore,
      volume_spike: input.volumeSpike,
      spread_width: input.spreadWidth,
      anomaly_score: input.anomalyScore,
      source_count: input.sourceCount,
      sentiment_confidence: input.sentimentConfidence,
      estimated_edge: input.estimatedEdge,
      category: input.category,
    };

    try {
      const stdout = await execFileAsync(
        'python3',
        [PREDICT_SCRIPT, '--model', MODEL_PATH, JSON.stringify(payload)],
        { timeout: 5000 }
      );

      const parsed = JSON.parse(stdout.trim()) as {
        probability: number;
        edge: number;
        market_price: number;
        used_fallback: boolean;
        has_model: boolean;
      };

      const latencyMs = Date.now() - start;
      const passesGate = Math.abs(parsed.edge) >= XGBOOST_GATE_THRESHOLD;

      logger.debug('XGBoostFastModel: prediction complete', {
        probability: parsed.probability,
        edge: parsed.edge,
        passesGate,
        usedFallback: parsed.used_fallback,
        latencyMs,
      });

      return {
        probability: parsed.probability,
        edge: parsed.edge,
        marketPrice: parsed.market_price,
        usedFallback: parsed.used_fallback,
        hasModel: parsed.has_model,
        passesGate,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      logger.warn('XGBoostFastModel: subprocess failed, using market price as fallback', { err });

      // Fail-open with market price — let LLM ensemble decide
      return {
        probability: input.marketPrice,
        edge: 0,
        marketPrice: input.marketPrice,
        usedFallback: true,
        hasModel: false,
        passesGate: true, // fail-open: don't block LLM if XGBoost errors
        latencyMs,
      };
    }
  }

  /** Build FastModelInput from ResearchBrief + MarketSignal */
  static buildInput(brief: ResearchBrief, signal: MarketSignal): FastModelInput {
    return {
      marketPrice: brief.currentMarketPrice,
      daysToExpiry:
        (signal.market.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
      volume24h: signal.market.volume24h,
      totalLiquidity: signal.market.totalLiquidity,
      sentimentScore: brief.sentimentScore,
      volumeSpike: signal.volumeSpike,
      spreadWidth: signal.spreadWidth,
      anomalyScore: signal.anomalyScore,
      sourceCount: brief.sources.length,
      sentimentConfidence: Math.abs(brief.sentimentScore),
      estimatedEdge: brief.estimatedEdge,
      category: signal.market.category,
    };
  }
}
