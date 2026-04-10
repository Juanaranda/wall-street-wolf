import fs from 'fs';
import { logger } from '../shared/logger';
import {
  PredictionResult,
  RiskAssessment,
  TradeOrder,
  TradeResult,
  Platform,
} from '../shared/types';
import { generateTradeId } from '../shared/utils';
import { PolymarketExecutor } from './polymarket-executor';
import { KalshiExecutor } from './kalshi-executor';
import { OrderRequest, ExecutionResult } from './types';

export class ExecutionEngine {
  private readonly polyExecutor: PolymarketExecutor;
  private readonly kalshiExecutor: KalshiExecutor;

  constructor(
    polyPrivateKey: string,
    polyApiKey: string,
    polySecret: string,
    polyPassphrase: string,
    kalshiApiKeyId: string,
    kalshiPrivateKey: string,
    polyBaseUrl?: string,
    kalshiBaseUrl?: string
  ) {
    this.polyExecutor = new PolymarketExecutor(polyPrivateKey, polyApiKey, polySecret, polyPassphrase, polyBaseUrl);
    this.kalshiExecutor = new KalshiExecutor(kalshiApiKeyId, kalshiPrivateKey, kalshiBaseUrl);
  }

  async initialize(): Promise<void> {
    await this.kalshiExecutor.authenticate();
  }

  /**
   * Execute a trade given a prediction and approved risk assessment.
   * Returns null if the kill switch is active or execution fails.
   */
  async execute(
    prediction: PredictionResult,
    risk: RiskAssessment,
    platform: Platform
  ): Promise<TradeResult | null> {
    // Kill switch check
    if (fs.existsSync('./STOP')) {
      logger.warn('ExecutionEngine: STOP file detected — aborting execution');
      return null;
    }

    if (!risk.approved) {
      logger.warn('ExecutionEngine: risk assessment not approved', {
        marketId: prediction.marketId,
        reasons: risk.rejectionReasons,
      });
      return null;
    }

    if (prediction.direction === 'pass') {
      logger.info('ExecutionEngine: prediction direction is pass — no trade');
      return null;
    }

    const limitPrice =
      prediction.direction === 'yes'
        ? prediction.marketProbability
        : 1 - prediction.marketProbability;

    const req: OrderRequest = {
      marketId: prediction.marketId,
      platform,
      direction: prediction.direction,
      sizeUsd: risk.positionSize,
      limitPrice,
      maxSlippagePct: 0.02,
      timeoutMs: 30_000,
    };

    logger.info('ExecutionEngine: placing order', {
      marketId: req.marketId,
      platform,
      direction: req.direction,
      size: req.sizeUsd,
      price: req.limitPrice,
    });

    const result = platform === 'polymarket'
      ? await this.polyExecutor.placeOrder(req)
      : await this.kalshiExecutor.placeOrder(req);

    if (!result.success) {
      logger.error('ExecutionEngine: order failed', {
        marketId: prediction.marketId,
        error: result.error,
        abortReason: result.abortReason,
      });
      return null;
    }

    const tradeResult: TradeResult = {
      orderId: result.orderId ?? generateTradeId(),
      marketId: prediction.marketId,
      platform,
      direction: prediction.direction,
      filledSize: result.filledSize ?? 0,
      filledPrice: result.filledPrice ?? limitPrice,
      slippage: result.slippage ?? 0,
      fees: result.fees ?? 0,
      status: result.filledSize && result.filledSize > 0 ? 'filled' : 'pending',
      timestamp: new Date(),
    };

    logger.info('ExecutionEngine: trade result', tradeResult);
    return tradeResult;
  }

  async cancelOrder(platform: Platform, orderId: string): Promise<boolean> {
    if (platform === 'polymarket') return this.polyExecutor.cancelOrder(orderId);
    return this.kalshiExecutor.cancelOrder(orderId);
  }
}

export { PolymarketExecutor, KalshiExecutor };
