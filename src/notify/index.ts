// Required .env keys for WhatsApp notifications via Twilio:
//   TWILIO_ACCOUNT_SID     – Twilio Account SID (starts with "AC")
//   TWILIO_AUTH_TOKEN      – Twilio Auth Token
//   TWILIO_WHATSAPP_FROM   – Twilio sandbox sender number, e.g. +14155238886
//   USER_WHATSAPP_TO       – Recipient WhatsApp number, e.g. +56912345678
//
// When all four are present, createNotifier() returns TwilioWhatsAppNotifier.
// If any is missing, it falls back to ConsoleNotifier so the pipeline always works.

import axios from 'axios';
import { Recommendation } from '../shared/types';
import { logger } from '../shared/logger';
import { EmailNotifier } from './email';

/**
 * Delivers recommendations to the user. Decoupled so the channel (WhatsApp via
 * Twilio sandbox → Meta Cloud API) can change without touching the rest.
 */
export interface Notifier {
  send(rec: Recommendation): Promise<void>;
  /** Send a free-text message (e.g. the weekly review summary). */
  sendText(message: string): Promise<void>;
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
 * credentials.
 */
export class ConsoleNotifier implements Notifier {
  async send(rec: Recommendation): Promise<void> {
    logger.info(`Notifier (console):\n${formatRecommendation(rec)}`);
  }

  async sendText(message: string): Promise<void> {
    logger.info(`Notifier (console):\n${message}`);
  }
}

/**
 * Sends recommendations via Twilio WhatsApp Sandbox (paper phase) or the
 * Meta Cloud API number once promoted to production.
 *
 * Uses axios with HTTP Basic auth — no Twilio SDK dependency.
 * On send failure the error is logged and swallowed so the pipeline continues.
 */
export class TwilioWhatsAppNotifier implements Notifier {
  private readonly url: string;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly fromNumber: string,
    private readonly toNumber: string,
  ) {
    this.url =
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  }

  async send(rec: Recommendation): Promise<void> {
    await this.sendMessage(formatRecommendation(rec), `${rec.ticker} (${rec.action})`);
  }

  async sendText(message: string): Promise<void> {
    await this.sendMessage(message, 'free-text');
  }

  private async sendMessage(body: string, label: string): Promise<void> {
    // Twilio Messages API requires application/x-www-form-urlencoded
    const params = new URLSearchParams({
      From: `whatsapp:${this.fromNumber}`,
      To: `whatsapp:${this.toNumber}`,
      Body: body,
    });

    try {
      await axios.post(this.url, params.toString(), {
        auth: {
          username: this.accountSid,
          password: this.authToken,
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      logger.info(`WhatsApp notification sent: ${label}`);
    } catch (err) {
      // A failed notification must NOT crash the pipeline.
      logger.error('TwilioWhatsAppNotifier: failed to send message', { err });
    }
  }
}

/**
 * Factory that returns the appropriate notifier based on environment variables.
 *
 * Priority: Email (SMTP) → WhatsApp (Twilio) → Console.
 * Email is preferred because it's free with any SMTP provider; Console is the
 * zero-config fallback so the pipeline always works (you just read it here).
 */
export function createNotifier(): Notifier {
  const email = EmailNotifier.fromEnv();
  if (email) {
    logger.info('Notifier: using EmailNotifier (SMTP)');
    return email;
  }

  const sid = process.env['TWILIO_ACCOUNT_SID'];
  const token = process.env['TWILIO_AUTH_TOKEN'];
  const from = process.env['TWILIO_WHATSAPP_FROM'];
  const to = process.env['USER_WHATSAPP_TO'];
  if (sid && token && from && to) {
    logger.info('Notifier: using TwilioWhatsAppNotifier');
    return new TwilioWhatsAppNotifier(sid, token, from, to);
  }

  logger.info('Notifier: no email/WhatsApp env set — using ConsoleNotifier (output shown here)');
  return new ConsoleNotifier();
}
