import { EmailNotifier } from '../src/notify/email';
import { createNotifier, ConsoleNotifier } from '../src/notify';
import { Recommendation } from '../src/shared/types';

jest.mock('../src/shared/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const rec: Recommendation = {
  id: 'r1', ticker: 'AAPL', action: 'buy', suggestedAmountUsd: 100, confidence: 0.9, rationale: 'mom', createdAt: new Date(),
};

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_TO', 'EMAIL_FROM'];

describe('EmailNotifier', () => {
  it('sends a recommendation email with subject + body', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    const n = new EmailNotifier({ sendMail } as never, 'from@x.com', 'to@x.com');
    await n.send(rec);

    expect(sendMail).toHaveBeenCalledTimes(1);
    const arg = sendMail.mock.calls[0]![0];
    expect(arg.to).toBe('to@x.com');
    expect(arg.subject).toContain('AAPL');
    expect(arg.text).toContain('COMPRAR AAPL');
  });

  it('sends free text (weekly review) with first line as subject', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    const n = new EmailNotifier({ sendMail } as never, 'f@x.com', 't@x.com');
    await n.sendText('Resumen semanal\nlínea 2');
    expect(sendMail.mock.calls[0]![0].subject).toBe('Resumen semanal');
  });

  it('never throws when the transport fails', async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error('smtp down'));
    const n = new EmailNotifier({ sendMail } as never, 'f@x.com', 't@x.com');
    await expect(n.send(rec)).resolves.toBeUndefined();
  });

  it('fromEnv returns null when SMTP is not configured', () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of SMTP_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    expect(EmailNotifier.fromEnv()).toBeNull();
    for (const k of SMTP_KEYS) if (saved[k] !== undefined) process.env[k] = saved[k];
  });
});

describe('createNotifier', () => {
  it('falls back to ConsoleNotifier when nothing is configured', () => {
    const saved: Record<string, string | undefined> = {};
    const keys = [...SMTP_KEYS, 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_WHATSAPP_FROM', 'USER_WHATSAPP_TO'];
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    expect(createNotifier()).toBeInstanceOf(ConsoleNotifier);
    for (const k of keys) if (saved[k] !== undefined) process.env[k] = saved[k];
  });

  it('prefers EmailNotifier when SMTP env is set', () => {
    const prev = { ...process.env };
    process.env['SMTP_HOST'] = 'smtp.test';
    process.env['SMTP_USER'] = 'u';
    process.env['SMTP_PASS'] = 'p';
    process.env['EMAIL_TO'] = 'to@x.com';
    expect(createNotifier()).toBeInstanceOf(EmailNotifier);
    process.env = prev;
  });
});
