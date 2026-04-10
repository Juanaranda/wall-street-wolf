import fs from 'fs';
import path from 'path';
import { ResearchBrief, PredictionResult, ModelVote, MarketSignal } from '../shared/types';
import { logger } from '../shared/logger';
import { round, mispricingZScore, expectedValue } from '../shared/utils';
import { db } from '../shared/database';
import { EnsembleForecaster } from './ensemble';
import { CalibrationTracker } from './calibration';
import { XGBoostFastModel, XGBOOST_GATE_THRESHOLD } from './fast-model';
import { EnsembleConfig, ModelConfig, ModelPromptContext } from './types';

// OpenRouter model IDs — update these if you want different versions
// Full list: https://openrouter.ai/models
const DEFAULT_MODELS: ModelConfig[] = [
  {
    name: 'claude-forecaster',
    role: 'primary_forecaster',
    weight: 0.25,
    provider: 'openrouter',
    modelId: 'anthropic/claude-sonnet-4-5',   // Claude — strong reasoning
  },
  {
    name: 'gpt-news',
    role: 'news_analyst',
    weight: 0.20,
    provider: 'openrouter',
    modelId: 'openai/gpt-4o',                 // GPT-4o — great at news synthesis
  },
  {
    name: 'gemini-bull',
    role: 'bull_advocate',
    weight: 0.20,
    provider: 'openrouter',
    modelId: 'google/gemini-2.0-flash-001',   // Gemini — fast, broad knowledge
  },
  {
    name: 'deepseek-bear',
    role: 'bear_advocate',
    weight: 0.20,
    provider: 'openrouter',
    modelId: 'deepseek/deepseek-chat',        // DeepSeek V3 — strong analytical
  },
  {
    name: 'grok-risk',
    role: 'risk_manager',
    weight: 0.05,
    provider: 'openrouter',
    modelId: 'x-ai/grok-3-mini-beta',        // Grok — real-time X/Twitter context
  },
  // XGBoost occupies the remaining 0.10 weight and is injected as a ModelVote
];

const DEFAULT_CONFIG: EnsembleConfig = {
  minEdge: 0.04,
  minConfidence: 0.55,
  models: DEFAULT_MODELS,
};

const XGBOOST_WEIGHT = 0.10;
const PREDICTION_LOG_PATH = process.env['PREDICTION_LOG_PATH'] ?? './data/predictions.jsonl';

export class PredictionEngine {
  private readonly forecaster: EnsembleForecaster;
  private readonly calibration: CalibrationTracker;
  private readonly xgboost: XGBoostFastModel;
  private readonly config: EnsembleConfig;

  constructor(
    openRouterApiKey: string,
    config: Partial<EnsembleConfig> = {}
  ) {
    this.forecaster = new EnsembleForecaster(openRouterApiKey);
    this.calibration = new CalibrationTracker();
    this.xgboost = new XGBoostFastModel();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Full prediction pipeline:
   * 1. XGBoost fast gate check (no LLM cost if edge < threshold)
   * 2. LLM ensemble (only if XGBoost passes gate)
   * 3. Weighted combination of XGBoost + LLM votes
   */
  async predict(
    brief: ResearchBrief,
    daysToExpiry: number,
    signal?: MarketSignal
  ): Promise<PredictionResult> {
    logger.info(`PredictionEngine: analyzing market ${brief.marketId}`);

    // ── Step 1: XGBoost fast gate ─────────────────────────────────────────
    let xgbProbability = brief.currentMarketPrice;
    let xgbPassed = true;

    if (signal) {
      const fastInput = XGBoostFastModel.buildInput(brief, signal);
      const fastResult = await this.xgboost.predict(fastInput);

      xgbProbability = fastResult.probability;
      xgbPassed = fastResult.passesGate;

      logger.info(`PredictionEngine: XGBoost gate`, {
        probability: fastResult.probability,
        edge: fastResult.edge,
        passesGate: fastResult.passesGate,
        usedFallback: fastResult.usedFallback,
        latencyMs: fastResult.latencyMs,
      });

      if (!xgbPassed) {
        logger.info(`PredictionEngine: XGBoost gate BLOCKED — edge ${(fastResult.edge * 100).toFixed(2)}% < ${(XGBOOST_GATE_THRESHOLD * 100).toFixed(0)}% threshold. Skipping LLM calls.`);
        const passResult = this.buildPassResult(brief, xgbProbability, [{
          model: 'xgboost',
          probability: xgbProbability,
          weight: XGBOOST_WEIGHT,
          reasoning: `XGBoost edge ${(fastResult.edge * 100).toFixed(2)}% below gate threshold. No LLM calls made.`,
        }]);
        this.logPrediction(passResult);
        return passResult;
      }
    }

    // ── Step 2: LLM ensemble ──────────────────────────────────────────────
    const ctx: ModelPromptContext = {
      question: brief.summary,
      marketPrice: brief.currentMarketPrice,
      researchSummary: brief.summary,
      narrativeConsensus: brief.narrativeConsensus,
      daysToExpiry,
      sentimentScore: brief.sentimentScore,
      role: 'primary_forecaster',
    };

    const responses = await this.forecaster.queryAll(this.config.models, ctx);

    // ── Step 3: Combine XGBoost + LLM votes ──────────────────────────────
    const xgbVote: ModelVote = {
      model: 'xgboost',
      probability: xgbProbability,
      weight: XGBOOST_WEIGHT,
      reasoning: `XGBoost data-driven estimate. Gate edge: ${((xgbProbability - brief.currentMarketPrice) * 100).toFixed(2)}%.`,
    };

    const llmVotes: ModelVote[] = responses.map((r) => {
      const cfg = this.config.models.find((m) => m.name === r.model);
      return {
        model: r.model,
        probability: r.probability,
        weight: cfg?.weight ?? 0.2,
        reasoning: r.reasoning,
      };
    });

    const allVotes = [xgbVote, ...llmVotes];

    // Weighted average across all votes
    const totalWeight = allVotes.reduce((s, v) => s + v.weight, 0);
    const modelProbability = allVotes.reduce(
      (s, v) => s + (v.probability * v.weight) / totalWeight,
      0
    );

    // Confidence: average of LLM confidences (XGBoost is always "confident")
    const avgLlmConfidence =
      responses.length > 0
        ? responses.reduce((s, r) => s + r.confidence, 0) / responses.length
        : 0.5;

    const edge = modelProbability - brief.currentMarketPrice;
    const mispricingScore = mispricingZScore(modelProbability, brief.currentMarketPrice, 0.15);
    const decimalOdds = brief.currentMarketPrice > 0 ? 1 / brief.currentMarketPrice : 2;
    const ev = expectedValue(modelProbability, decimalOdds);

    let direction: PredictionResult['direction'] = 'pass';
    if (Math.abs(edge) >= this.config.minEdge && avgLlmConfidence >= this.config.minConfidence) {
      direction = edge > 0 ? 'yes' : 'no';
    }

    const result: PredictionResult = {
      marketId: brief.marketId,
      modelProbability: round(modelProbability),
      marketProbability: round(brief.currentMarketPrice),
      edge: round(edge),
      confidence: round(avgLlmConfidence),
      direction,
      modelVotes: allVotes,
      mispricingScore: round(mispricingScore),
      expectedValue: round(ev),
      timestamp: new Date(),
    };

    logger.info(`PredictionEngine: result for ${brief.marketId}`, {
      modelP: result.modelProbability,
      marketP: result.marketProbability,
      edge: result.edge,
      direction: result.direction,
      xgbProbability,
      llmModelsQueried: responses.length,
    });

    this.logPrediction(result);
    return result;
  }

  /** Persist prediction to PostgreSQL + JSONL fallback */
  private logPrediction(result: PredictionResult): void {
    // Postgres (fire-and-forget — don't await in hot path)
    db.insertPrediction(result).catch(() => {/* logged inside */});

    // JSONL fallback — always written regardless of Postgres availability
    try {
      const dir = path.dirname(PREDICTION_LOG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(PREDICTION_LOG_PATH, JSON.stringify(result) + '\n');
    } catch (err) {
      logger.warn('PredictionEngine: failed to write prediction JSONL', { err });
    }
  }

  recordOutcome(marketId: string, predicted: number, outcome: boolean): void {
    // Write to in-memory calibration tracker (JSONL)
    const record = this.calibration.record(marketId, predicted, outcome);
    logger.info(`CalibrationTracker: Brier=${record.brierScore.toFixed(4)}`, {
      marketId,
      avgBrier: this.calibration.averageBrierScore(),
    });
    // Write to PostgreSQL (fire-and-forget)
    db.resolveMarket(marketId, outcome).catch(() => {/* logged inside */});
  }

  getCalibrationStats() {
    return {
      avgBrierScore: this.calibration.averageBrierScore(),
      buckets: this.calibration.calibrationStats(),
    };
  }

  private buildPassResult(
    brief: ResearchBrief,
    modelProbability: number,
    votes: ModelVote[]
  ): PredictionResult {
    const edge = modelProbability - brief.currentMarketPrice;
    return {
      marketId: brief.marketId,
      modelProbability: round(modelProbability),
      marketProbability: round(brief.currentMarketPrice),
      edge: round(edge),
      confidence: 0,
      direction: 'pass',
      modelVotes: votes,
      mispricingScore: 0,
      expectedValue: 0,
      timestamp: new Date(),
    };
  }
}

export { CalibrationTracker, EnsembleForecaster, XGBoostFastModel };
