import { Platform, Direction, TradeStatus } from '../shared/types';

export interface OrderRequest {
  marketId: string;
  platform: Platform;
  direction: Direction;
  sizeUsd: number;
  limitPrice: number;
  maxSlippagePct: number;    // e.g. 0.02 = 2%
  timeoutMs: number;         // order timeout before cancel
}

export interface RawOrderResponse {
  orderId: string;
  status: TradeStatus;
  filledSize: number;
  filledPrice: number;
  fees: number;
  timestamp: Date;
  rawResponse?: unknown;
}

export interface KalshiOrderPayload {
  ticker: string;
  client_order_id: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  type: 'limit';
  count: number;
  yes_price?: number;
  no_price?: number;
}

export interface PolymarketOrderPayload {
  tokenID: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  type: 'LIMIT';
  feeRateBps: number;
  nonce: string;
  expiration: number;
}

export interface ExecutionResult {
  success: boolean;
  orderId?: string;
  filledSize?: number;
  filledPrice?: number;
  slippage?: number;
  fees?: number;
  error?: string;
  abortReason?: string;
}
