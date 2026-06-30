import { randomUUID } from 'crypto';
import schedule from 'node-schedule';
import { logger } from './shared/logger';
import { isKillSwitchActive } from './shared/utils';
import { Instrument, Signal, Recommendation } from './shared/types';
import { UniverseProvider, StaticUniverse } from './universe';
import { MarketDataProvider, createDataProvider } from './data';
import { createSignalEngines, StrategyEngine } from './signals/factory';
import { Notifier, createNotifier } from './notify';
import { Ledger, PaperLedger } from './ledger';
import { sizePosition, DEFAULT_SIZING, SizingConfig } from './risk/equity-sizing';
import { SignalReviewer } from './compound/signal-review';
import { sendWeeklyReview } from './compound/weekly-review';
import { buildPortfolio } from './compound/portfolio';
import { formatPlan } from './compound/plan';

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
  private weeklyJob: schedule.Job | null = null;

  constructor(
    private readonly universe: UniverseProvider = new StaticUniverse(),
    private readonly data: MarketDataProvider = createDataProvider(),
    private readonly engines: StrategyEngine[] = createSignalEngines(),
    private readonly notifier: Notifier = createNotifier(),
    private readonly ledger: Ledger = new PaperLedger(),
    private readonly sizing: SizingConfig = DEFAULT_SIZING
  ) {}

  async initialize(): Promise<void> {
    logger.info('SignalOrchestrator: initializing (momentum, paper mode)...');
    logger.info('SignalOrchestrator: ready');
  }

  /** Run one full pipeline cycle. Returns the recommendations sent (buys + sells). */
  async runCycle(): Promise<Recommendation[]> {
    if (isKillSwitchActive()) {
      logger.warn('SignalOrchestrator: kill switch active — skipping cycle');
      return [];
    }

    const instruments = await this.universe.list();
    const heldShares = new Map(this.ledger.openPositions().map((p) => [p.ticker, p.shares]));
    logger.info(`SignalOrchestrator: evaluating ${instruments.length} instruments (${heldShares.size} held)`);

    // Run every strategy over each instrument (bars fetched once, shared).
    // Buys are deduped by ticker (highest confidence wins, tagged with its strategy).
    // A held ticker is exited if ANY strategy signals 'sell'.
    interface BuyCandidate { signal: Signal; inst: Instrument; strategy: string; horizon: string; }
    const buyByTicker = new Map<string, BuyCandidate>();
    const sells: Recommendation[] = [];
    const soldTickers = new Set<string>();

    for (const inst of instruments) {
      try {
        const bars = await this.data.getBars(inst.ticker, '1Day', 300);
        const lastPrice = bars.length ? bars[bars.length - 1]!.close : null;
        const held = heldShares.get(inst.ticker);

        for (const { name, horizon, engine, exitAuthority } of this.engines) {
          const signal = await engine.evaluate(inst.ticker, bars);

          if (held && held > 0 && signal.action === 'sell' && exitAuthority && !soldTickers.has(inst.ticker)) {
            // Only the exit-authority strategy (Momentum) closes positions.
            sells.push(this.toSellRecommendation(inst, signal, held, lastPrice, name, horizon));
            soldTickers.add(inst.ticker);
          } else if (!held && signal.action === 'buy' && signal.confidence >= MIN_CONFIDENCE) {
            const existing = buyByTicker.get(inst.ticker);
            if (!existing || signal.confidence > existing.signal.confidence) {
              buyByTicker.set(inst.ticker, { signal, inst, strategy: name, horizon });
            }
          }
        }
      } catch (err) {
        logger.warn(`SignalOrchestrator: failed to evaluate ${inst.ticker}`, { err });
      }
    }
    const buyCandidates = [...buyByTicker.values()];

    // Build the account snapshot once (cash + holdings) — used for cash-aware
    // sizing AND the email. Recommendations don't change holdings, so it stays valid.
    const portfolio = await buildPortfolio(this.ledger, this.data);

    // Size buys against AVAILABLE CASH: never recommend more than you can pay for.
    // Per-trade size scales with total account value; capped by remaining cash.
    const bankroll = portfolio.accountValueUsd > 0 ? portfolio.accountValueUsd : this.sizing.bankrollUsd;
    let availableCash = portfolio.cashUsd;
    const buys: Recommendation[] = [];
    for (const { signal, inst, strategy, horizon } of buyCandidates
      .sort((a, b) => b.signal.confidence - a.signal.confidence)
      .slice(0, MAX_SIGNALS_PER_CYCLE)) {
      const target = sizePosition(signal.confidence, { ...this.sizing, bankrollUsd: bankroll });
      const amount = Math.min(target, availableCash);
      if (amount < this.sizing.minUsd) continue; // not enough cash left
      availableCash -= amount;
      buys.push(this.toBuyRecommendation(signal, inst, Math.round(amount * 100) / 100, strategy, horizon));
    }

    // Sells first — exits matter more than new entries.
    const recommendations = [...sells, ...buys];
    for (const rec of recommendations) this.ledger.recordRecommendation(rec);

    // One consolidated plan email per run (buys + sells + cash + balance).
    // Send daily whenever there's anything to report OR any holding/cash.
    if (recommendations.length > 0 || portfolio.holdings.length > 0 || portfolio.cashUsd > 0) {
      await this.notifier.sendText(formatPlan(recommendations, portfolio));
    }

    logger.info(
      `SignalOrchestrator: cycle complete — ${sells.length} sell(s), ${buys.length} buy(s), cash US$${portfolio.cashUsd.toFixed(2)}`
    );
    return recommendations;
  }

  private toBuyRecommendation(
    signal: Signal,
    inst: Instrument,
    amountUsd: number,
    strategy: string,
    horizon: string
  ): Recommendation {
    return {
      id: randomUUID(),
      ticker: signal.ticker,
      action: 'buy',
      suggestedAmountUsd: amountUsd,
      confidence: signal.confidence,
      rationale: `${inst.name}: ${signal.reasons.join(', ')}`,
      createdAt: new Date(),
      strategy,
      horizon,
    };
  }

  private toSellRecommendation(
    inst: Instrument,
    signal: Signal,
    shares: number,
    lastPrice: number | null,
    strategy: string,
    horizon: string
  ): Recommendation {
    const value = lastPrice ? Math.round(shares * lastPrice * 100) / 100 : 0;
    return {
      id: randomUUID(),
      ticker: inst.ticker,
      action: 'sell',
      suggestedAmountUsd: value,
      confidence: signal.confidence,
      rationale: `${inst.name}: señal de salida (${signal.reasons.join(', ')}). Vender tus ${shares} acciones${value ? ` (~US$${value})` : ''}.`,
      createdAt: new Date(),
      strategy,
      horizon,
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

    // Weekly review summary — Sundays 18:00 (#13).
    this.weeklyJob = schedule.scheduleJob('0 18 * * 0', () => {
      if (this.isRunning) void this.runWeeklyReview();
    });
  }

  /** Build and send the weekly review summary. */
  async runWeeklyReview(): Promise<void> {
    try {
      const reviewer = new SignalReviewer(this.ledger, this.data);
      await sendWeeklyReview(reviewer, this.notifier);
      logger.info('SignalOrchestrator: weekly review sent');
    } catch (err) {
      logger.warn('SignalOrchestrator: weekly review failed', { err });
    }
  }

  stop(): void {
    logger.info('SignalOrchestrator: stopping...');
    this.isRunning = false;
    if (this.job) {
      this.job.cancel();
      this.job = null;
    }
    if (this.weeklyJob) {
      this.weeklyJob.cancel();
      this.weeklyJob = null;
    }
  }
}

const MIN_CONFIDENCE = parseFloat(process.env['MIN_SIGNAL_CONFIDENCE'] ?? '0.6');
const MAX_SIGNALS_PER_CYCLE = parseInt(process.env['MAX_SIGNALS_PER_CYCLE'] ?? '3', 10);
const DEFAULT_INTERVAL_MS = parseInt(process.env['SCAN_INTERVAL_MS'] ?? '86400000', 10); // daily
