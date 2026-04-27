import axios, { AxiosInstance } from 'axios';
import { logger } from '../shared/logger';
import { OrderRequest, ExecutionResult } from './types';

const PAPER_BASE = 'https://paper-api.alpaca.markets';
const LIVE_BASE = 'https://api.alpaca.markets';

interface AlpacaOrderResponse {
  id: string;
  status: string;
  filled_qty: string;
  filled_avg_price: string | null;
}

export class AlpacaExecutor {
  private readonly http: AxiosInstance;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly paperTrading: boolean
  ) {
    const baseURL = paperTrading ? PAPER_BASE : LIVE_BASE;
    this.http = axios.create({
      baseURL,
      timeout: 15_000,
      headers: {
        'Content-Type': 'application/json',
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': apiSecret,
      },
    });
  }

  async authenticate(): Promise<void> {
    try {
      const response = await this.http.get<{ status: string; id: string }>('/v2/account');
      logger.info('AlpacaExecutor: authenticated', {
        accountId: response.data.id,
        status: response.data.status,
        paper: this.paperTrading,
      });
    } catch (err: any) {
      throw new Error(`AlpacaExecutor: account check failed — ${err?.message ?? String(err)}`);
    }
  }

  async placeOrder(req: OrderRequest): Promise<ExecutionResult> {
    if (req.platform !== 'alpaca') {
      return { success: false, error: 'Wrong executor for platform' };
    }

    if (process.env['DRY_RUN'] === 'true') {
      logger.info('AlpacaExecutor: DRY RUN — simulated fill', {
        symbol: req.marketId,
        direction: req.direction,
        sizeUsd: req.sizeUsd,
        limitPrice: req.limitPrice,
      });
      return {
        success: true,
        orderId: `dry-alpaca-${Date.now()}`,
        filledSize: req.sizeUsd,
        filledPrice: req.limitPrice,
        slippage: 0,
        fees: 0,
      };
    }

    if (!this.apiKey || !this.apiSecret) {
      return { success: false, error: 'AlpacaExecutor: API key/secret not configured' };
    }

    const side = req.direction === 'long' ? 'buy' : 'sell';

    const payload = {
      symbol: req.marketId,
      notional: req.sizeUsd.toFixed(2),
      side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: req.limitPrice.toFixed(2),
    };

    try {
      const response = await this.http.post<AlpacaOrderResponse>('/v2/orders', payload);
      const order = response.data;

      const filledPrice = order.filled_avg_price
        ? parseFloat(order.filled_avg_price)
        : req.limitPrice;
      const filledSize = parseFloat(order.filled_qty);
      const slippage = Math.abs(filledPrice - req.limitPrice) / req.limitPrice;

      logger.info('AlpacaExecutor: order placed', {
        orderId: order.id,
        status: order.status,
        filledSize,
        filledPrice,
      });

      return {
        success: true,
        orderId: order.id,
        filledSize,
        filledPrice,
        slippage,
        fees: 0, // Alpaca is commission-free
      };
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ??
        err?.response?.data?.code ??
        err?.message ??
        String(err);
      logger.error('AlpacaExecutor.placeOrder failed', {
        symbol: req.marketId,
        status: err?.response?.status,
        error: msg,
      });
      return { success: false, error: msg };
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.http.delete(`/v2/orders/${orderId}`);
      logger.info('AlpacaExecutor: order cancelled', { orderId });
      return true;
    } catch (err: any) {
      logger.error('AlpacaExecutor.cancelOrder failed', {
        orderId,
        error: err?.message ?? String(err),
      });
      return false;
    }
  }
}
