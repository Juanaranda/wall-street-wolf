import axios from 'axios';
import {
  ConsoleNotifier,
  TwilioWhatsAppNotifier,
  createNotifier,
  formatRecommendation,
} from '../src/notify/index';
import { Recommendation } from '../src/shared/types';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('axios');
const mockedAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>;

jest.mock('../src/shared/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { logger } from '../src/shared/logger';
const mockLogger = logger as jest.Mocked<typeof logger>;

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeRec = (overrides: Partial<Recommendation> = {}): Recommendation => ({
  id: 'rec-001',
  ticker: 'AAPL',
  action: 'buy',
  suggestedAmountUsd: 500,
  confidence: 0.82,
  rationale: 'RSI oversold + MACD crossover',
  createdAt: new Date('2026-05-30T12:00:00Z'),
  ...overrides,
});

// ── formatRecommendation ──────────────────────────────────────────────────────

describe('formatRecommendation', () => {
  it('includes ticker, amount, confidence, rationale, and disclaimer', () => {
    const rec = makeRec();
    const msg = formatRecommendation(rec);

    expect(msg).toContain('AAPL');
    expect(msg).toContain('US$500');
    expect(msg).toContain('82%');
    expect(msg).toContain('RSI oversold + MACD crossover');
    expect(msg).toContain('Fintual');
  });

  it('uses COMPRAR verb for buy action', () => {
    const msg = formatRecommendation(makeRec({ action: 'buy' }));
    expect(msg).toContain('COMPRAR');
    expect(msg).not.toContain('VENDER');
  });

  it('uses VENDER verb for sell action', () => {
    const msg = formatRecommendation(makeRec({ action: 'sell' }));
    expect(msg).toContain('VENDER');
    expect(msg).not.toContain('COMPRAR');
  });

  it('rounds amount to zero decimal places', () => {
    const msg = formatRecommendation(makeRec({ suggestedAmountUsd: 123.7 }));
    expect(msg).toContain('US$124');
  });

  it('rounds confidence to zero decimal places', () => {
    const msg = formatRecommendation(makeRec({ confidence: 0.756 }));
    expect(msg).toContain('76%');
  });
});

// ── ConsoleNotifier ───────────────────────────────────────────────────────────

describe('ConsoleNotifier', () => {
  beforeEach(() => jest.clearAllMocks());

  it('logs the formatted recommendation', async () => {
    const notifier = new ConsoleNotifier();
    const rec = makeRec();
    await notifier.send(rec);

    expect(mockLogger.info).toHaveBeenCalledTimes(1);
    const [msg] = (mockLogger.info as jest.Mock).mock.calls[0] as [string];
    expect(msg).toContain('AAPL');
  });

  it('does not call axios', async () => {
    const notifier = new ConsoleNotifier();
    await notifier.send(makeRec());
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });
});

// ── TwilioWhatsAppNotifier ────────────────────────────────────────────────────

describe('TwilioWhatsAppNotifier', () => {
  const SID = 'ACtest123';
  const TOKEN = 'token456';
  const FROM = '+14155238886';
  const TO = '+56912345678';

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxiosPost.mockResolvedValue({ status: 201, data: { sid: 'SM123' } });
  });

  it('posts to the correct Twilio URL', async () => {
    const notifier = new TwilioWhatsAppNotifier(SID, TOKEN, FROM, TO);
    await notifier.send(makeRec());

    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    const [url] = mockedAxiosPost.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
    );
  });

  it('sends form-encoded body with whatsapp: prefixed numbers', async () => {
    const notifier = new TwilioWhatsAppNotifier(SID, TOKEN, FROM, TO);
    await notifier.send(makeRec());

    const call = mockedAxiosPost.mock.calls[0] as unknown as [string, string, ...unknown[]];
    const [, bodyArg] = call;
    const params = new URLSearchParams(bodyArg);
    expect(params.get('From')).toBe(`whatsapp:${FROM}`);
    expect(params.get('To')).toBe(`whatsapp:${TO}`);
  });

  it('body contains the formatted recommendation text', async () => {
    const rec = makeRec();
    const notifier = new TwilioWhatsAppNotifier(SID, TOKEN, FROM, TO);
    await notifier.send(rec);

    const call2 = mockedAxiosPost.mock.calls[0] as unknown as [string, string, ...unknown[]];
    const [, bodyArg2] = call2;
    const params = new URLSearchParams(bodyArg2);
    const msgBody = params.get('Body') ?? '';
    expect(msgBody).toContain('AAPL');
    expect(msgBody).toContain('COMPRAR');
  });

  it('uses HTTP Basic auth with SID as username and token as password', async () => {
    const notifier = new TwilioWhatsAppNotifier(SID, TOKEN, FROM, TO);
    await notifier.send(makeRec());

    const authCall = mockedAxiosPost.mock.calls[0] as unknown as [
      string,
      string,
      { auth: { username: string; password: string } },
    ];
    const [, , config] = authCall;
    expect(config.auth.username).toBe(SID);
    expect(config.auth.password).toBe(TOKEN);
  });

  it('sets Content-Type to application/x-www-form-urlencoded', async () => {
    const notifier = new TwilioWhatsAppNotifier(SID, TOKEN, FROM, TO);
    await notifier.send(makeRec());

    const ctCall = mockedAxiosPost.mock.calls[0] as unknown as [
      string,
      string,
      { headers: Record<string, string> },
    ];
    const [, , ctConfig] = ctCall;
    expect(ctConfig.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('logs success after a successful send', async () => {
    const notifier = new TwilioWhatsAppNotifier(SID, TOKEN, FROM, TO);
    await notifier.send(makeRec());

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('AAPL'),
    );
  });

  it('logs error and does NOT throw when axios rejects', async () => {
    mockedAxiosPost.mockRejectedValueOnce(new Error('Network error'));
    const notifier = new TwilioWhatsAppNotifier(SID, TOKEN, FROM, TO);

    // Must not throw — pipeline must survive notification failures
    await expect(notifier.send(makeRec())).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('TwilioWhatsAppNotifier'),
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('logs error and does NOT throw on HTTP 4xx response error', async () => {
    const apiError = Object.assign(new Error('Unauthorized'), {
      response: { status: 401, data: { message: 'Unauthorized' } },
    });
    mockedAxiosPost.mockRejectedValueOnce(apiError);
    const notifier = new TwilioWhatsAppNotifier(SID, TOKEN, FROM, TO);

    await expect(notifier.send(makeRec())).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

// ── createNotifier factory ────────────────────────────────────────────────────

describe('createNotifier', () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Isolate env changes per test
    process.env = { ...ORIG_ENV };
  });

  afterAll(() => {
    process.env = ORIG_ENV;
  });

  it('returns TwilioWhatsAppNotifier when all four env vars are set', () => {
    process.env['TWILIO_ACCOUNT_SID'] = 'ACtest';
    process.env['TWILIO_AUTH_TOKEN'] = 'token';
    process.env['TWILIO_WHATSAPP_FROM'] = '+14155238886';
    process.env['USER_WHATSAPP_TO'] = '+56912345678';

    const notifier = createNotifier();
    expect(notifier).toBeInstanceOf(TwilioWhatsAppNotifier);
  });

  it('returns ConsoleNotifier when TWILIO_ACCOUNT_SID is missing', () => {
    delete process.env['TWILIO_ACCOUNT_SID'];
    process.env['TWILIO_AUTH_TOKEN'] = 'token';
    process.env['TWILIO_WHATSAPP_FROM'] = '+14155238886';
    process.env['USER_WHATSAPP_TO'] = '+56912345678';

    const notifier = createNotifier();
    expect(notifier).toBeInstanceOf(ConsoleNotifier);
  });

  it('returns ConsoleNotifier when TWILIO_AUTH_TOKEN is missing', () => {
    process.env['TWILIO_ACCOUNT_SID'] = 'ACtest';
    delete process.env['TWILIO_AUTH_TOKEN'];
    process.env['TWILIO_WHATSAPP_FROM'] = '+14155238886';
    process.env['USER_WHATSAPP_TO'] = '+56912345678';

    const notifier = createNotifier();
    expect(notifier).toBeInstanceOf(ConsoleNotifier);
  });

  it('returns ConsoleNotifier when TWILIO_WHATSAPP_FROM is missing', () => {
    process.env['TWILIO_ACCOUNT_SID'] = 'ACtest';
    process.env['TWILIO_AUTH_TOKEN'] = 'token';
    delete process.env['TWILIO_WHATSAPP_FROM'];
    process.env['USER_WHATSAPP_TO'] = '+56912345678';

    const notifier = createNotifier();
    expect(notifier).toBeInstanceOf(ConsoleNotifier);
  });

  it('returns ConsoleNotifier when USER_WHATSAPP_TO is missing', () => {
    process.env['TWILIO_ACCOUNT_SID'] = 'ACtest';
    process.env['TWILIO_AUTH_TOKEN'] = 'token';
    process.env['TWILIO_WHATSAPP_FROM'] = '+14155238886';
    delete process.env['USER_WHATSAPP_TO'];

    const notifier = createNotifier();
    expect(notifier).toBeInstanceOf(ConsoleNotifier);
  });

  it('returns ConsoleNotifier when no env vars are set', () => {
    delete process.env['TWILIO_ACCOUNT_SID'];
    delete process.env['TWILIO_AUTH_TOKEN'];
    delete process.env['TWILIO_WHATSAPP_FROM'];
    delete process.env['USER_WHATSAPP_TO'];

    const notifier = createNotifier();
    expect(notifier).toBeInstanceOf(ConsoleNotifier);
  });
});
