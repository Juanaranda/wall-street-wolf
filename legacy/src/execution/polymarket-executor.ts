import { ethers } from 'ethers';
import { logger } from '../shared/logger';
import { OrderRequest, ExecutionResult } from './types';

const CLOB_BASE = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet

// Lazy-loaded to avoid ESM/CJS conflict at module load time
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClobClientInstance = any;

export class PolymarketExecutor {
  private client: ClobClientInstance = null;
  private readonly ready: boolean;
  private readonly privateKey: string;
  private readonly apiKey: string;
  private readonly secret: string;
  private readonly passphrase: string;
  private readonly baseUrl: string;

  constructor(
    privateKey: string,
    apiKey: string,
    secret: string,
    passphrase: string,
    baseUrl: string = CLOB_BASE
  ) {
    const hasCredentials = apiKey && secret && passphrase &&
      !privateKey.startsWith('0x000000000000000000000000000000000000000000000000000000000000000');

    this.privateKey = privateKey;
    this.apiKey = apiKey;
    this.secret = secret;
    this.passphrase = passphrase;
    this.baseUrl = baseUrl;
    this.ready = Boolean(hasCredentials);

    if (!this.ready) {
      logger.warn('PolymarketExecutor: no credentials — Polymarket orders disabled. Run scripts/setup-polymarket.ts to configure.');
    }
  }

  /** Lazily initializes ClobClient on first use (avoids ESM top-level import) */
  private async ensureClient(): Promise<ClobClientInstance> {
    if (this.client) return this.client;

    const { ClobClient } = await import('@polymarket/clob-client');

    const wallet = new ethers.Wallet(this.privateKey);
    const signer = {
      getAddress: () => wallet.getAddress(),
      _signTypedData: (
        domain: Record<string, unknown>,
        types: Record<string, Array<{ name: string; type: string }>>,
        value: Record<string, unknown>
      ) => wallet.signTypedData(domain, types, value),
    };

    this.client = new ClobClient(
      this.baseUrl,
      CHAIN_ID,
      signer,
      { key: this.apiKey, secret: this.secret, passphrase: this.passphrase }
    );

    return this.client;
  }

  async placeOrder(req: OrderRequest): Promise<ExecutionResult> {
    if (req.platform !== 'polymarket') {
      return { success: false, error: 'Wrong executor for platform' };
    }
    if (!this.ready) {
      return { success: false, error: 'Polymarket not configured — run scripts/setup-polymarket.ts' };
    }

    try {
      const { OrderType, Side } = await import('@polymarket/clob-client');
      const client = await this.ensureClient();

      const signedOrder = await client.createOrder({
        tokenID: req.marketId,
        price: req.limitPrice,
        size: req.sizeUsd,
        side: req.direction === 'yes' ? Side.BUY : Side.SELL,
      });

      // Slippage check
      const book = await client.getOrderBook(req.marketId);
      const bestEntry = req.direction === 'yes' ? book?.asks?.[0] : book?.bids?.[0];
      const currentPrice = bestEntry ? parseFloat(bestEntry.price) : null;

      if (currentPrice !== null) {
        const deviation = Math.abs(currentPrice - req.limitPrice) / req.limitPrice;
        if (deviation > req.maxSlippagePct) {
          logger.warn('PolymarketExecutor: slippage guard triggered', {
            marketId: req.marketId, currentPrice, limitPrice: req.limitPrice, deviation,
          });
          return {
            success: false,
            abortReason: `Slippage ${(deviation * 100).toFixed(2)}% exceeds max ${(req.maxSlippagePct * 100).toFixed(2)}%`,
          };
        }
      }

      const response = await client.postOrder(signedOrder, OrderType.GTC);
      const orderId: string = response?.orderID ?? response?.order_id ?? 'unknown';
      const filledSize: number = response?.size_matched ?? 0;
      const filledPrice: number = response?.price ?? req.limitPrice;
      const slippage = Math.abs(filledPrice - req.limitPrice) / req.limitPrice;

      logger.info('PolymarketExecutor: order placed', { orderId, filledSize, filledPrice, slippage });
      return { success: true, orderId, filledSize, filledPrice, slippage, fees: 0 };
    } catch (err) {
      logger.error('PolymarketExecutor.placeOrder failed', { marketId: req.marketId, err });
      return { success: false, error: String(err) };
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.ready) return false;
    try {
      const client = await this.ensureClient();
      await client.cancelOrder({ orderID: orderId });
      logger.info('PolymarketExecutor: order cancelled', { orderId });
      return true;
    } catch (err) {
      logger.error('PolymarketExecutor.cancelOrder failed', { orderId, err });
      return false;
    }
  }
}
