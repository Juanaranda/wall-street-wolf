import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { createPrivateKey, sign as cryptoSign, constants as cryptoConstants } from 'crypto';
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
      // Build full path: baseUrl contributes its pathname prefix (e.g. /trade-api/v2)
      // new URL(relPath, base) with an absolute relPath ignores base's pathname, so we build manually
      const basePath = new URL(baseUrl).pathname.replace(/\/$/, '');
      const reqParsed = new URL(config.url ?? '', 'http://localhost');
      const pathAndQuery = basePath + reqParsed.pathname + reqParsed.search;
      // Kalshi signs: timestamp + method + path (body NOT included)
      const keyObj = createPrivateKey(this.privateKey);
      const signature = cryptoSign(
        'sha256',
        Buffer.from(timestampMs + method + pathAndQuery),
        { key: keyObj, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST }
      ).toString('base64');

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

    // Kalshi prices in cents (1–99, never 0 or 100)
    const priceInCents = Math.min(99, Math.max(1, Math.round(req.limitPrice * 100)));
    // Minimum 1 contract, rounded down to avoid over-sizing
    const contractCount = Math.max(1, Math.floor(req.sizeUsd));

    // Kalshi only supports 'yes' | 'no' sides; 'long'/'short' are not valid here
    const kalshiSide: 'yes' | 'no' =
      req.direction === 'yes' || req.direction === 'no' ? req.direction : 'yes';

    const payload: KalshiOrderPayload = {
      ticker: req.marketId,
      client_order_id: uuidv4(),
      action: 'buy',
      side: kalshiSide,
      type: 'limit',
      count: contractCount,
      [kalshiSide === 'yes' ? 'yes_price' : 'no_price']: priceInCents,
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
      }>('/portfolio/orders', payload);

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
    } catch (err: any) {
      const apiError = err?.response?.data?.error;
      const msg = apiError ? `${apiError.code}: ${apiError.message}` : String(err);
      logger.error('KalshiExecutor.placeOrder failed', { marketId: req.marketId, status: err?.response?.status, error: msg });
      return { success: false, error: msg };
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
