import { Recommendation } from '../shared/types';
import { logger } from '../shared/logger';

/**
 * Delivers recommendations to the user. Decoupled so the channel (WhatsApp via
 * Twilio sandbox → Meta Cloud API) can change without touching the rest.
 */
export interface Notifier {
  send(rec: Recommendation): Promise<void>;
}

/** Human-readable WhatsApp/console message for a recommendation. */
export function formatRecommendation(rec: Recommendation): string {
  const verb = rec.action === 'buy' ? '🟢 COMPRAR' : '🔴 VENDER';
  return [
    `${verb} ${rec.ticker}`,
    `Monto sugerido: US$${rec.suggestedAmountUsd.toFixed(0)}`,
    `Confianza: ${(rec.confidence * 100).toFixed(0)}%`,
    ``,
    rec.rationale,
    ``,
    `⚠️ Sugerencia, no asesoría. Ejecuta manual en Fintual.`,
  ].join('\n');
}

/**
 * Default notifier — logs to console. Lets the pipeline run without external
 * credentials. The notify/ agent (issue #5) adds the Twilio WhatsApp implementation
 * behind this same interface.
 */
export class ConsoleNotifier implements Notifier {
  async send(rec: Recommendation): Promise<void> {
    logger.info(`Notifier (console):\n${formatRecommendation(rec)}`);
  }
}
