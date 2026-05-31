import { randomUUID } from 'crypto';
import schedule from 'node-schedule';
import { logger } from './shared/logger';
import { isKillSwitchActive } from './shared/utils';
import { Instrument, Signal, Recommendation, SignalAction } from './shared/types';
import { UniverseProvider, StaticUniverse } from './universe';
import { MarketDataProvider, AlpacaDataProvider } from './data';
import { SignalEngine, TechnicalSignalEngine } from './signals';
import { Notifier, ConsoleNotifier } from './notify';
import { Ledger, PaperLedger } from './ledger';

/**
 * Semi-automated signal pipeline:
 *   Universe → Data → Signals → (sizing) → Notify → Ledger
 *
 * Low-frequency by design. The system only SUGGESTS; the user executes manually
 * in Fintual. Risk sizing, the LLM gate, and real persistence are filled in by the
 * per-module agents (issues #2–#7).
 */
export class SignalOrchestrator {
  private isRunning = false;
  private job: schedule.Job | null = null;

  constructor(
    private readonly universe: UniverseProvider = new StaticUniverse(),
    private readonly data: MarketDataProvider = new AlpacaDataProvider(
      process.env['ALPACA_API_KEY'] ?? '',
      process.env['ALPACA_API_SECRET'] ?? ''
    ),
    private readonly signals: SignalEngine = new TechnicalSignalEngine(),
    private readonly notifier: Notifier = new ConsoleNotifier(),
    private readonly ledger: Ledger = new PaperLedger()
  ) {}

  async initialize(): Promise<void> {
    logger.info('SignalOrchestrator: initializing (paper mode)...');
    logger.info('SignalOrchestrator: ready');
  }

  /** Run one full pipeline cycle. */
  async runCycle(): Promise<void> {
    if (isKillSwitchActive()) {
      logger.warn('SignalOrchestrator: kill switch active — skipping cycle');
      return;
    }

    const instruments = await this.universe.list();
    logger.info(`SignalOrchestrator: evaluating ${instruments.length} instruments`);

    const signals: Signal[] = [];
    for (const inst of instruments) {
      try {
        const bars = await this.data.getBars(inst.ticker, '1Day', 100);
        const signal = await this.signals.evaluate(inst.ticker, bars);
        if (signal.action !== 'hold') signals.push(signal);
      } catch (err) {
        logger.warn(`SignalOrchestrator: failed to evaluate ${inst.ticker}`, { err });
      }
    }

    const actionable = signals
      .filter((s) => s.confidence >= MIN_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_SIGNALS_PER_CYCLE);

    for (const signal of actionable) {
      const rec = this.toRecommendation(signal, instruments);
      this.ledger.recordRecommendation(rec);
      await this.notifier.send(rec);
    }

    logger.info(`SignalOrchestrator: cycle complete — ${actionable.length} recommendation(s) sent`);
  }

  /** Build a recommendation from a signal. Sizing is a placeholder until issue #10. */
  private toRecommendation(signal: Signal, instruments: Instrument[]): Recommendation {
    const inst = instruments.find((i) => i.ticker === signal.ticker);
    const action: SignalAction = signal.action;
    return {
      id: randomUUID(),
      ticker: signal.ticker,
      action: action === 'sell' ? 'sell' : 'buy',
      suggestedAmountUsd: PLACEHOLDER_AMOUNT_USD,
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
const PLACEHOLDER_AMOUNT_USD = 100; // replaced by Fintual-aware sizing in issue #10
const DEFAULT_INTERVAL_MS = parseInt(process.env['SCAN_INTERVAL_MS'] ?? '3600000', 10); // 1h
