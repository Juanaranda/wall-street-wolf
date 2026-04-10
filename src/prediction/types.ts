export interface ModelPromptContext {
  question: string;
  marketPrice: number;
  researchSummary: string;
  narrativeConsensus: string;
  daysToExpiry: number;
  sentimentScore: number;
  role: 'primary_forecaster' | 'news_analyst' | 'bull_advocate' | 'bear_advocate' | 'risk_manager';
}

export interface RawModelResponse {
  model: string;
  probability: number;
  reasoning: string;
  confidence: number;
  latencyMs: number;
}

export interface EnsembleConfig {
  minEdge: number;            // 0.04
  minConfidence: number;      // 0.6
  models: ModelConfig[];
}

export interface ModelConfig {
  name: string;
  role: ModelPromptContext['role'];
  weight: number;
  provider: 'openrouter';
  modelId: string;
}

export interface CalibrationRecord {
  marketId: string;
  predictedProbability: number;
  actualOutcome: boolean;
  brierScore: number;
  timestamp: Date;
}
