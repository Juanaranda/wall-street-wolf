import axios from 'axios';
import { SentimentLlmCaller, ChatFn, NewsFn } from '../src/signals/sentiment-gate';
import { fetchRecentHeadlines } from '../src/research/news';
import { createSignalEngine } from '../src/signals/factory';
import { LlmGatedSignalEngine } from '../src/signals';
import { MomentumEngine } from '../src/signals/strategies/momentum';
import { Signal } from '../src/shared/types';

jest.mock('axios');
jest.mock('../src/shared/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
const mockedAxios = axios as jest.Mocked<typeof axios>;

const sig: Signal = { ticker: 'AAPL', action: 'buy', strength: 0.9, confidence: 0.8, reasons: [], timestamp: new Date() };

describe('fetchRecentHeadlines', () => {
  const KEY = 'FINNHUB_API_KEY';
  afterEach(() => { delete process.env[KEY]; jest.clearAllMocks(); });

  it('returns [] without an API key (never calls network)', async () => {
    delete process.env[KEY];
    const r = await fetchRecentHeadlines('AAPL');
    expect(r).toEqual([]);
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('maps Finnhub items to headlines (capped)', async () => {
    process.env[KEY] = 'x';
    mockedAxios.get.mockResolvedValueOnce({ data: [
      { headline: 'Apple beats earnings' }, { headline: 'New iPhone launch' }, { headline: '' },
    ] });
    const r = await fetchRecentHeadlines('AAPL', 7, 5);
    expect(r).toEqual(['Apple beats earnings', 'New iPhone launch']);
  });

  it('returns [] on error', async () => {
    process.env[KEY] = 'x';
    mockedAxios.get.mockRejectedValueOnce(new Error('rate limited'));
    expect(await fetchRecentHeadlines('AAPL')).toEqual([]);
  });
});

describe('SentimentLlmCaller', () => {
  it('returns neutral when no chat (no API key)', async () => {
    const caller = new SentimentLlmCaller(null);
    const r = await caller.gate('AAPL', sig);
    expect(r.confidenceDelta).toBe(0);
    expect(r.estimatedCostUsd).toBe(0);
  });

  it('returns neutral when there is no news', async () => {
    const chat: ChatFn = jest.fn(async () => '{"score":0.5}');
    const news: NewsFn = jest.fn(async () => []);
    const caller = new SentimentLlmCaller(chat, news);
    const r = await caller.gate('AAPL', sig);
    expect(r.confidenceDelta).toBe(0);
    expect(chat).not.toHaveBeenCalled();
  });

  it('maps positive sentiment to a positive confidence delta', async () => {
    const chat: ChatFn = jest.fn(async () => '{"score": 1.0, "reason": "earnings beat"}');
    const news: NewsFn = jest.fn(async () => ['Apple beats earnings']);
    const caller = new SentimentLlmCaller(chat, news, 0.0005);
    const r = await caller.gate('AAPL', sig);
    expect(r.confidenceDelta).toBeCloseTo(0.3, 6); // 1.0 * 0.3, capped
    expect(r.additionalReasons[0]).toContain('noticias');
    expect(r.estimatedCostUsd).toBe(0.0005);
  });

  it('maps negative sentiment to a negative delta (caps at -0.3)', async () => {
    const chat: ChatFn = jest.fn(async () => '{"score": -1, "reason": "fraud probe"}');
    const caller = new SentimentLlmCaller(chat, async () => ['SEC probes company']);
    const r = await caller.gate('AAPL', sig);
    expect(r.confidenceDelta).toBeCloseTo(-0.3, 6);
  });

  it('degrades to neutral on unparseable output', async () => {
    const chat: ChatFn = jest.fn(async () => 'no soy json');
    const caller = new SentimentLlmCaller(chat, async () => ['headline']);
    const r = await caller.gate('AAPL', sig);
    expect(r.confidenceDelta).toBe(0);
  });
});

describe('createSignalEngine', () => {
  const KEY = 'OPENROUTER_API_KEY';
  afterEach(() => { delete process.env[KEY]; delete process.env['SENTIMENT_GATE']; });

  it('returns plain MomentumEngine without an LLM key', () => {
    delete process.env[KEY];
    expect(createSignalEngine()).toBeInstanceOf(MomentumEngine);
  });

  it('wraps in the LLM gate when a key is present', () => {
    process.env[KEY] = 'x';
    expect(createSignalEngine()).toBeInstanceOf(LlmGatedSignalEngine);
  });

  it('respects SENTIMENT_GATE=false', () => {
    process.env[KEY] = 'x';
    process.env['SENTIMENT_GATE'] = 'false';
    expect(createSignalEngine()).toBeInstanceOf(MomentumEngine);
  });
});
