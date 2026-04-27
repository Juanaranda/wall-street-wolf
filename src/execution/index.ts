import fs from 'fs';
import { logger } from '../shared/logger';
import {
  PredictionResult,
  RiskAssessment,
  TradeResult,
  Platform,
} from '../shared/types';
import { generateTradeId } from '../shared/utils';
import { PolymarketExecutor } from './polymarket-executor';
import { KalshiExecutor } from './kalshi-executor';
import { BinanceExecutor } from './binance-executor';
import { AlpacaExecutor } from './alpaca-executor';
import { OrderRequest, ExecutionResult } from './types';

export class ExecutionEngine {
  private readonly polyExecutor: PolymarketExecutor;
  private readonly kalshiExecutor: KalshiExecutor;
  private readonly binanceExecutor: BinanceExecutor | null;
  private readonly alpacaExecutor: AlpacaExecutor | null;

  constructor(
    polyPrivateKey: string,
    polyApiKey: string,
    polySecret: string,
    polyPassphrase: string,
    kalshiApiKeyId: string,
    kalshiPrivateKey: string,
    polyBaseUrl?: string,
    kalshiBaseUrl?: string,
    binanceApiKey?: string,
    binanceApiSecret?: string,
    binanceBaseUrl?: string,
    binanceTestnet?: boolean,
    alpacaApiKey?: string,
    alpacaApiSecret?: string,
    alpacaPaper?: boolean
  ) {
    this.polyExecutor = new PolymarketExecutor(
      polyPrivateKey, polyApiKey, polySecret, polyPassphrase, polyBaseUrl
    );
    this.kalshiExecutor = new KalshiExecutor(kalshiApiKeyId, kalshiPrivateKey, kalshiBaseUrl);

    this.binanceExecutor =
      binanceApiKey && binanceApiSecret && binanceBaseUrl
        ? new BinanceExecutor(binanceApiKey, binanceApiSecret, binanceBaseUrl, binanceTestnet ?? true)
        : null;

    this.alpacaExecutor =
      alpacaApiKey && alpacaApiSecret
        ? new AlpacaExecutor(alpacaApiKey, alpacaApiSecret, alpacaPaper ?? true)
        : null;
  }

  async initialize(): Promise<void> {
    await this.kalshiExecutor.authenticate();
    if (this.binanceExecutor) await this.binanceExecutor.authenticate();
    if (this.alpacaExecutor) await this.alpacaExecutor.authenticate();
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

    // Dry-run mode: log what would be traded but don't place orders
    if (process.env['DRY_RUN'] === 'true') {
      const limitPrice =
        prediction.direction === 'yes' || prediction.direction === 'long'
          ? prediction.marketProbability
          : 1 - prediction.marketProbability;
      logger.info('ExecutionEngine: DRY RUN — would place order', {
        marketId: prediction.marketId,
        platform,
        direction: prediction.direction,
        size: risk.positionSize,
        price: limitPrice,
        edge: prediction.modelProbability - prediction.marketProbability,
      });
      return {
        orderId: `dry-${Date.now()}`,
        marketId: prediction.marketId,
        platform,
        direction: prediction.direction as 'yes' | 'no',
        filledSize: risk.positionSize,
        filledPrice: limitPrice,
        slippage: 0,
        fees: 0,
        status: 'filled',
        timestamp: new Date(),
      };
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
      prediction.direction === 'yes' || prediction.direction === 'long'
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

    let result: ExecutionResult;
    if (platform === 'polymarket') {
      result = await this.polyExecutor.placeOrder(req);
    } else if (platform === 'kalshi') {
      result = await this.kalshiExecutor.placeOrder(req);
    } else if (platform === 'binance') {
      if (!this.binanceExecutor) {
        logger.error('ExecutionEngine: Binance executor not configured');
        return null;
      }
      result = await this.binanceExecutor.placeOrder(req);
    } else if (platform === 'alpaca') {
      if (!this.alpacaExecutor) {
        logger.error('ExecutionEngine: Alpaca executor not configured');
        return null;
      }
      result = await this.alpacaExecutor.placeOrder(req);
    } else {
      logger.error('ExecutionEngine: unknown platform', { platform });
      return null;
    }

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
    if (platform === 'kalshi') return this.kalshiExecutor.cancelOrder(orderId);
    if (platform === 'binance') {
      if (!this.binanceExecutor) return false;
      return this.binanceExecutor.cancelOrder(orderId);
    }
    if (platform === 'alpaca') {
      if (!this.alpacaExecutor) return false;
      return this.alpacaExecutor.cancelOrder(orderId);
    }
    return false;
  }
}

export { PolymarketExecutor, KalshiExecutor };
