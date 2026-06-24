import nodemailer, { Transporter } from 'nodemailer';
import { Recommendation } from '../shared/types';
import { logger } from '../shared/logger';
import { Notifier, formatRecommendation } from './index';

/**
 * Email notifier over generic SMTP (free with Gmail + an app password, or any
 * provider). Decoupled like the WhatsApp notifier — same Notifier interface.
 *
 * Required .env keys (all must be set for createNotifier to pick this):
 *   SMTP_HOST       e.g. smtp.gmail.com
 *   SMTP_PORT       e.g. 465 (SSL) or 587 (STARTTLS); default 465
 *   SMTP_USER       SMTP username (the sending account)
 *   SMTP_PASS       SMTP password / Gmail app password
 *   EMAIL_TO        recipient address
 *   EMAIL_FROM      optional sender (defaults to SMTP_USER)
 */
export class EmailNotifier implements Notifier {
  constructor(
    private readonly transporter: Pick<Transporter, 'sendMail'>,
    private readonly from: string,
    private readonly to: string
  ) {}

  async send(rec: Recommendation): Promise<void> {
    await this.email(`🟢 Señal: ${rec.action.toUpperCase()} ${rec.ticker}`, formatRecommendation(rec));
  }

  async sendText(message: string): Promise<void> {
    const subject = message.split('\n')[0]?.slice(0, 120) || 'Plan de inversión';
    await this.email(subject, message);
  }

  private async email(subject: string, text: string): Promise<void> {
    // Retry once on transient SMTP/network failures before giving up.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.transporter.sendMail({ from: this.from, to: this.to, subject, text });
        logger.info(`EmailNotifier: sent "${subject}" to ${this.to}`);
        return;
      } catch (err) {
        if (attempt === 2) {
          // A failed notification must NOT crash the pipeline.
          logger.error('EmailNotifier: failed to send email after retry', { err });
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  /** Build from env vars, or null if SMTP is not fully configured. */
  static fromEnv(): EmailNotifier | null {
    const host = process.env['SMTP_HOST'];
    const user = process.env['SMTP_USER'];
    const pass = process.env['SMTP_PASS'];
    const to = process.env['EMAIL_TO'];
    if (!host || !user || !pass || !to) return null;

    const port = parseInt(process.env['SMTP_PORT'] ?? '465', 10);
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
    return new EmailNotifier(transporter, process.env['EMAIL_FROM'] ?? user, to);
  }
}
