import OpenAI from 'openai';
import { logger } from '../shared/logger';
import { ModelPromptContext, RawModelResponse, ModelConfig } from './types';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const SYSTEM_PROMPTS: Record<ModelPromptContext['role'], string> = {
  primary_forecaster:
    'You are a world-class prediction market forecaster with expertise in base rates, ' +
    'outside view thinking, and superforecasting. Analyze all available evidence objectively.',
  news_analyst:
    'You are an expert news analyst specializing in real-world event prediction. ' +
    'Focus on what the latest news and information implies about the probability of this event.',
  bull_advocate:
    'You are making the strongest possible BULLISH case (YES outcome) for this market. ' +
    'Argue why the probability should be HIGHER than the current market price.',
  bear_advocate:
    'You are making the strongest possible BEARISH case (NO outcome) for this market. ' +
    'Argue why the probability should be LOWER than the current market price.',
  risk_manager:
    'You are a conservative risk manager evaluating uncertainty. Focus on tail risks, ' +
    'unknown unknowns, and reasons why predictions could be wrong.',
};

function buildUserPrompt(ctx: ModelPromptContext): string {
  return `
PREDICTION MARKET ANALYSIS

Question: ${ctx.question}
Current Market Price (Yes): ${(ctx.marketPrice * 100).toFixed(1)}%
Days to Resolution: ${ctx.daysToExpiry.toFixed(1)}
Sentiment Score: ${ctx.sentimentScore.toFixed(3)} (-1=bearish, +1=bullish)

Research Summary:
${ctx.researchSummary}

Narrative Consensus:
${ctx.narrativeConsensus}

Your task: Estimate the TRUE probability that this event resolves YES.

Respond ONLY in this exact JSON format:
{
  "probability": <number between 0.01 and 0.99>,
  "confidence": <number between 0.1 and 1.0>,
  "reasoning": "<1-2 sentence explanation>"
}
`.trim();
}

export class EnsembleForecaster {
  private readonly client: OpenAI;

  constructor(openRouterApiKey: string) {
    this.client = new OpenAI({
      apiKey: openRouterApiKey,
      baseURL: OPENROUTER_BASE,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/wall-street-wolf',
        'X-Title': 'Wall Street Wolf',
      },
    });
  }

  async queryModel(
    config: ModelConfig,
    ctx: ModelPromptContext
  ): Promise<RawModelResponse> {
    const start = Date.now();
    const userPrompt = buildUserPrompt(ctx);
    const systemPrompt = SYSTEM_PROMPTS[config.role];

    // Models that natively support json_object response_format via OpenRouter
    const JSON_MODE_MODELS = new Set([
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'openai/gpt-4-turbo',
    ]);

    try {
      const response = await this.client.chat.completions.create({
        model: config.modelId,
        max_tokens: 256,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        ...(JSON_MODE_MODELS.has(config.modelId) ? { response_format: { type: 'json_object' as const } } : {}),
      });

      const rawText = response.choices[0]?.message?.content ?? '';
      // Extract JSON block even if the model wraps it in markdown fences
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const jsonText = jsonMatch ? jsonMatch[0] : '{}';

      const parsed = JSON.parse(jsonText) as {
        probability?: number;
        confidence?: number;
        reasoning?: string;
      };

      const probability = Math.max(0.01, Math.min(0.99, parsed.probability ?? 0.5));
      const confidence = Math.max(0.1, Math.min(1.0, parsed.confidence ?? 0.5));

      logger.debug(`EnsembleForecaster: ${config.name} → p=${probability.toFixed(3)} conf=${confidence.toFixed(2)} (${Date.now() - start}ms)`);

      return {
        model: config.name,
        probability,
        confidence,
        reasoning: parsed.reasoning ?? 'No reasoning provided.',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`EnsembleForecaster: ${config.name} (${config.modelId}) failed: ${errMsg}`);
      return {
        model: config.name,
        probability: ctx.marketPrice,
        confidence: 0.1,
        reasoning: 'Model query failed — using market price as fallback.',
        latencyMs: Date.now() - start,
      };
    }
  }

  /** Query all models in parallel */
  async queryAll(
    models: ModelConfig[],
    ctx: ModelPromptContext
  ): Promise<RawModelResponse[]> {
    const responses = await Promise.allSettled(
      models.map((m) => this.queryModel(m, { ...ctx, role: m.role }))
    );

    return responses
      .filter((r): r is PromiseFulfilledResult<RawModelResponse> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

}
