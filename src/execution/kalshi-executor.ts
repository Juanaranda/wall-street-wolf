import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { createSign } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../shared/logger';
import { OrderRequest, RawOrderResponse, KalshiOrderPayload, ExecutionResult } from './types';

const DEMO_BASE = 'https://demo-api.kalshi.co/trade-api/v2';

export class KalshiExecutor {
  private readonly http: AxiosInstance;

  constructor(
    private readonly apiKeyId: string,
    private readonly privateKey: string,
    baseUrl: string = DEMO_BASE
  ) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });

    this.http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
      if (!this.apiKeyId || !this.privateKey) return config;

      const timestampMs = Date.now().toString();
      const method = (config.method ?? 'GET').toUpperCase();
      const url = new URL(config.url ?? '', baseUrl);
      const pathAndQuery = url.pathname + (url.search ?? '');
      const body = config.data ? JSON.stringify(config.data) : '';

      const signer = createSign('RSA-SHA256');
      signer.update(timestampMs + method + pathAndQuery + body);
      signer.end();
      const signature = signer.sign(this.privateKey, 'base64');

      config.headers['KALSHI-Access-Key'] = this.apiKeyId;
      config.headers['KALSHI-Access-Signature'] = signature;
      config.headers['KALSHI-Access-Timestamp'] = timestampMs;

      return config;
    });
  }

  /** RSA key auth — validates key presence, no login call needed. */
  async authenticate(): Promise<void> {
    if (!this.apiKeyId || !this.privateKey) {
      throw new Error('KalshiExecutor: KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY are required');
    }
    logger.info('KalshiExecutor: using RSA key authentication');
  }

  async placeOrder(req: OrderRequest): Promise<ExecutionResult> {
    if (req.platform !== 'kalshi') {
      return { success: false, error: 'Wrong executor for platform' };
    }

    if (!this.apiKeyId) await this.authenticate();

    // Fetch current mid-price for slippage check
    const currentPrice = await this.getCurrentPrice(req.marketId, req.direction);
    if (currentPrice !== null) {
      const priceDeviation = Math.abs(currentPrice - req.limitPrice) / req.limitPrice;
      if (priceDeviation > req.maxSlippagePct) {
        logger.warn('KalshiExecutor: slippage guard triggered', {
          marketId: req.marketId,
          currentPrice,
          limitPrice: req.limitPrice,
          deviation: priceDeviation,
        });
        return {
          success: false,
          abortReason: `Slippage ${(priceDeviation * 100).toFixed(2)}% exceeds max ${(req.maxSlippagePct * 100).toFixed(2)}%`,
        };
      }
    }

    // Kalshi prices in cents (0–99)
    const priceInCents = Math.round(req.limitPrice * 100);
    const contractCount = Math.round(req.sizeUsd); // 1 contract = $1 face value

    const payload: KalshiOrderPayload = {
      ticker: req.marketId,
      client_order_id: uuidv4(),
      action: 'buy',
      side: req.direction,
      type: 'limit',
      count: contractCount,
      [req.direction === 'yes' ? 'yes_price' : 'no_price']: priceInCents,
    };

    try {
      const response = await this.http.post<{
        order: {
          order_id: string;
          status: string;
          filled_count: number;
          avg_price: number;
          fees_paid: number;
        };
      }>('/portfolio/orders', { order: payload });

      const order = response.data.order;
      const filledPrice = (order.avg_price ?? priceInCents) / 100;
      const slippage = Math.abs(filledPrice - req.limitPrice) / req.limitPrice;

      logger.info('KalshiExecutor: order placed', {
        orderId: order.order_id,
        filledSize: order.filled_count,
        filledPrice,
        slippage,
      });

      return {
        success: true,
        orderId: order.order_id,
        filledSize: order.filled_count,
        filledPrice,
        slippage,
        fees: (order.fees_paid ?? 0) / 100,
      };
    } catch (err) {
      logger.error('KalshiExecutor.placeOrder failed', { marketId: req.marketId, err });
      return { success: false, error: String(err) };
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.http.delete(`/portfolio/orders/${orderId}`);
      logger.info('KalshiExecutor: order cancelled', { orderId });
      return true;
    } catch (err) {
      logger.error('KalshiExecutor.cancelOrder failed', { orderId, err });
      return false;
    }
  }

  private async getCurrentPrice(marketId: string, direction: string): Promise<number | null> {
    try {
      const response = await this.http.get<{
        market: { yes_bid: number; yes_ask: number; no_bid: number; no_ask: number };
      }>(`/markets/${marketId}`);
      const m = response.data.market;
      if (direction === 'yes') return (m.yes_bid + m.yes_ask) / 2 / 100;
      return (m.no_bid + m.no_ask) / 2 / 100;
    } catch {
      return null;
    }
  }
}
