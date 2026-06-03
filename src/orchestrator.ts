import { randomUUID } from 'crypto';
import schedule from 'node-schedule';
import { logger } from './shared/logger';
import { isKillSwitchActive } from './shared/utils';
import { Instrument, Signal, Recommendation } from './shared/types';
import { UniverseProvider, StaticUniverse } from './universe';
import { MarketDataProvider, createDataProvider } from './data';
import { SignalEngine } from './signals';
import { MomentumEngine } from './signals/strategies/momentum';
import { Notifier, createNotifier } from './notify';
import { Ledger, PaperLedger } from './ledger';
import { sizePosition, DEFAULT_SIZING, SizingConfig } from './risk/equity-sizing';

/**
 * Semi-automated signal pipeline:
 *   Universe → Data → Signals(momentum) → Sizing → Notify(WhatsApp) → Ledger
 *
 * Long-only, LOW-frequency by design. The system only SUGGESTS; the user executes
 * manually in Fintual. Momentum is the chosen strategy (robust out-of-sample); the
 * ML model did not beat baseline OOS, so we keep sober expectations and run paper.
 */
export class SignalOrchestrator {
  private isRunning = false;
  private job: schedule.Job | null = null;

  constructor(
    private readonly universe: UniverseProvider = new StaticUniverse(),
    private readonly data: MarketDataProvider = createDataProvider(),
    private readonly signals: SignalEngine = new MomentumEngine(),
    private readonly notifier: Notifier = createNotifier(),
    private readonly ledger: Ledger = new PaperLedger(),
    private readonly sizing: SizingConfig = DEFAULT_SIZING
  ) {}

  async initialize(): Promise<void> {
    logger.info('SignalOrchestrator: initializing (momentum, paper mode)...');
    logger.info('SignalOrchestrator: ready');
  }

  /** Run one full pipeline cycle. Returns the recommendations sent. */
  async runCycle(): Promise<Recommendation[]> {
    if (isKillSwitchActive()) {
      logger.warn('SignalOrchestrator: kill switch active — skipping cycle');
      return [];
    }

    const instruments = await this.universe.list();
    logger.info(`SignalOrchestrator: evaluating ${instruments.length} instruments`);

    const signals: Signal[] = [];
    for (const inst of instruments) {
      try {
        // Momentum needs ~252 bars of history; fetch a little more.
        const bars = await this.data.getBars(inst.ticker, '1Day', 300);
        const signal = await this.signals.evaluate(inst.ticker, bars);
        if (signal.action === 'buy') signals.push(signal); // long-only: act on buys
      } catch (err) {
        logger.warn(`SignalOrchestrator: failed to evaluate ${inst.ticker}`, { err });
      }
    }

    const actionable = signals
      .filter((s) => s.confidence >= MIN_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_SIGNALS_PER_CYCLE);

    const recommendations: Recommendation[] = [];
    for (const signal of actionable) {
      const rec = this.toRecommendation(signal, instruments);
      this.ledger.recordRecommendation(rec);
      await this.notifier.send(rec);
      recommendations.push(rec);
    }

    logger.info(`SignalOrchestrator: cycle complete — ${recommendations.length} recommendation(s) sent`);
    return recommendations;
  }

  private toRecommendation(signal: Signal, instruments: Instrument[]): Recommendation {
    const inst = instruments.find((i) => i.ticker === signal.ticker);
    return {
      id: randomUUID(),
      ticker: signal.ticker,
      action: 'buy', // long-only
      suggestedAmountUsd: sizePosition(signal.confidence, this.sizing),
      confidence: signal.confidence,
      rationale: `${inst?.name ?? signal.ticker}: ${signal.reasons.join(', ')}`,
      createdAt: new Date(),
    };
  }

  /** Start the low-frequency scheduler. */
  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    logger.info(`SignalOrchestrator: starting scheduler (interval: ${intervalMs}ms)`);
    this.isRunning = true;
    void this.runCycle();

    const intervalMinutes = Math.max(1, Math.floor(intervalMs / 60_000));
    this.job = schedule.scheduleJob(`*/${intervalMinutes} * * * *`, () => {
      if (this.isRunning && !isKillSwitchActive()) void this.runCycle();
    });
  }

  stop(): void {
    logger.info('SignalOrchestrator: stopping...');
    this.isRunning = false;
    if (this.job) {
      this.job.cancel();
      this.job = null;
    }
  }
}

const MIN_CONFIDENCE = parseFloat(process.env['MIN_SIGNAL_CONFIDENCE'] ?? '0.6');
const MAX_SIGNALS_PER_CYCLE = parseInt(process.env['MAX_SIGNALS_PER_CYCLE'] ?? '3', 10);
const DEFAULT_INTERVAL_MS = parseInt(process.env['SCAN_INTERVAL_MS'] ?? '86400000', 10); // daily
