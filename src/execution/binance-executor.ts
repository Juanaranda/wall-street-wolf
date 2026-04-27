import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger } from '../shared/logger';
import { OrderRequest, ExecutionResult } from './types';

export class BinanceExecutor {
  private readonly http: AxiosInstance;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly baseUrl: string,
    private readonly testnet: boolean
  ) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 15_000,
      headers: {
        'Content-Type': 'application/json',
        'X-MBX-APIKEY': apiKey,
      },
    });
  }

  /** Signs query string parameters with HMAC-SHA256. */
  private sign(queryString: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  /** Builds a signed params object by appending timestamp + signature. */
  private signedParams(params: Record<string, string | number>): Record<string, string | number> {
    const timestamp = Date.now();
    const withTimestamp = { ...params, timestamp };
    const queryString = new URLSearchParams(
      Object.entries(withTimestamp).reduce<Record<string, string>>(
        (acc, [k, v]) => { acc[k] = String(v); return acc; },
        {}
      )
    ).toString();
    const signature = this.sign(queryString);
    return { ...withTimestamp, signature };
  }

  async authenticate(): Promise<void> {
    try {
      await this.http.get('/v3/ping');
      logger.info('BinanceExecutor: connectivity test passed', { testnet: this.testnet });
    } catch (err: any) {
      throw new Error(`BinanceExecutor: ping failed — ${err?.message ?? String(err)}`);
    }
  }

  async placeOrder(req: OrderRequest): Promise<ExecutionResult> {
    if (req.platform !== 'binance') {
      return { success: false, error: 'Wrong executor for platform' };
    }

    if (process.env['DRY_RUN'] === 'true') {
      logger.info('BinanceExecutor: DRY RUN — simulated fill', {
        symbol: req.marketId,
        direction: req.direction,
        sizeUsd: req.sizeUsd,
        limitPrice: req.limitPrice,
      });
      return {
        success: true,
        orderId: `dry-binance-${Date.now()}`,
        filledSize: req.sizeUsd,
        filledPrice: req.limitPrice,
        slippage: 0,
        fees: 0,
      };
    }

    if (!this.apiKey || !this.apiSecret) {
      return { success: false, error: 'BinanceExecutor: API key/secret not configured' };
    }

    // Determine quantity from USD size ÷ price
    const quantity = (req.sizeUsd / req.limitPrice).toFixed(6);
    const limitPrice = req.limitPrice.toFixed(2);
    const side = req.direction === 'long' ? 'BUY' : 'SELL';

    const params = this.signedParams({
      symbol: req.marketId,
      side,
      type: 'LIMIT',
      timeInForce: 'GTC',
      quantity,
      price: limitPrice,
    });

    try {
      const response = await this.http.post<{
        orderId: number;
        status: string;
        executedQty: string;
        price: string;
        fills?: Array<{ price: string; qty: string; commission: string }>;
      }>('/v3/order', null, { params });

      const order = response.data;
      const filledSize = parseFloat(order.executedQty);
      const filledPrice = order.fills?.length
        ? order.fills.reduce((sum, f) => sum + parseFloat(f.price) * parseFloat(f.qty), 0) /
          order.fills.reduce((sum, f) => sum + parseFloat(f.qty), 0)
        : req.limitPrice;
      const fees = order.fills?.reduce((sum, f) => sum + parseFloat(f.commission), 0) ?? 0;
      const slippage = Math.abs(filledPrice - req.limitPrice) / req.limitPrice;

      logger.info('BinanceExecutor: order placed', {
        orderId: order.orderId,
        status: order.status,
        filledSize,
        filledPrice,
      });

      return {
        success: true,
        orderId: String(order.orderId),
        filledSize,
        filledPrice,
        slippage,
        fees,
      };
    } catch (err: any) {
      const msg = err?.response?.data?.msg ?? err?.message ?? String(err);
      logger.error('BinanceExecutor.placeOrder failed', {
        symbol: req.marketId,
        status: err?.response?.status,
        error: msg,
      });
      return { success: false, error: msg };
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    // orderId format: "symbol:orderId" e.g. "BTCUSDT:12345"
    const parts = orderId.split(':');
    const symbol = parts.length === 2 ? parts[0] : req_symbol_fallback(orderId);
    const rawOrderId = parts.length === 2 ? parts[1] : orderId;

    if (!symbol) {
      logger.error('BinanceExecutor.cancelOrder: cannot determine symbol from orderId', { orderId });
      return false;
    }

    const params = this.signedParams({ symbol, orderId: rawOrderId });

    try {
      await this.http.delete('/v3/order', { params });
      logger.info('BinanceExecutor: order cancelled', { orderId });
      return true;
    } catch (err: any) {
      logger.error('BinanceExecutor.cancelOrder failed', { orderId, err: err?.message });
      return false;
    }
  }
}

// Fallback: if orderId has no colon we cannot determine symbol; return empty string.
function req_symbol_fallback(_orderId: string): string {
  return '';
}
