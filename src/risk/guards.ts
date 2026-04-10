import fs from 'fs';
import { logger } from '../shared/logger';
import { PredictionResult, PortfolioState, RiskAssessment, RiskCheck, Position, Platform, Direction } from '../shared/types';
import { GuardResult, RiskGuardState, KellyInput } from './types';
import { calculateKelly, netOddsFromPrice, calculateVaR } from './kelly';

interface RiskConfig {
  minEdge: number;
  maxPositionSizeUsd: number;
  maxTotalExposureUsd: number;
  maxDailyLossUsd: number;
  maxDrawdownPct: number;
  maxConcurrentPositions: number;
  kellyFraction: number;
  maxDailyApiCostUsd: number;
  maxVaRUsd?: number;           // optional VaR hard cap; defaults to 95% of maxDailyLossUsd
}

export class RiskGuard {
  private state: RiskGuardState;
  private readonly config: RiskConfig;

  constructor(bankroll: number, config: RiskConfig) {
    this.config = config;
    this.state = {
      portfolio: {
        totalBankroll: bankroll,
        availableCash: bankroll,
        openPositions: [],
        dailyPnl: 0,
        totalPnl: 0,
        maxDrawdown: 0,
        winRate: 0,
        totalTrades: 0,
        sharpeRatio: 0,
      },
      dailyLossUsd: 0,
      dailyApiCostUsd: 0,
      tradesToday: 0,
      lastResetDate: new Date().toISOString().split('T')[0]!,
    };
  }

  /** Run all pre-trade risk checks and return a RiskAssessment */
  assess(prediction: PredictionResult): RiskAssessment {
    this.resetDailyStateIfNeeded();

    // Kill switch check
    if (fs.existsSync('./STOP')) {
      logger.warn('RiskGuard: KILL SWITCH ACTIVE — aborting all trades');
      return this.reject(prediction.marketId, [this.failCheck('kill_switch', 1, 0, 'STOP file detected')], 0);
    }

    // Pre-compute Kelly size so VaR check can use it
    const price = prediction.direction === 'yes'
      ? prediction.marketProbability
      : 1 - prediction.marketProbability;
    const kellyInput: KellyInput = {
      winProbability: prediction.modelProbability,
      netOdds: netOddsFromPrice(price),
      bankroll: this.state.portfolio.availableCash,
      kellyFraction: this.config.kellyFraction,
      maxPositionPct: 0.05,
    };
    const kelly = calculateKelly(kellyInput);
    const candidateSize = Math.min(kelly.recommendedSizeUsd, this.config.maxPositionSizeUsd);
    const var95 = calculateVaR(candidateSize, prediction.modelProbability);

    const guards: GuardResult[] = [
      this.checkEdge(prediction),
      this.checkDailyLoss(),
      this.checkDrawdown(),
      this.checkExposure(),
      this.checkConcurrentPositions(),
      this.checkApiCost(),
      this.checkVaR(var95),
    ];

    const failures = guards.filter((g) => !g.passed);

    if (failures.length > 0) {
      const reasons = failures.map((f) => f.reason);
      const checks = guards.map((g) => ({
        name: g.checkName,
        passed: g.passed,
        value: g.value,
        threshold: g.threshold,
      }));
      return this.reject(prediction.marketId, checks, 0, reasons);
    }

    const checks: RiskCheck[] = guards.map((g) => ({
      name: g.checkName,
      passed: g.passed,
      value: g.value,
      threshold: g.threshold,
    }));

    return {
      marketId: prediction.marketId,
      approved: true,
      rejectionReasons: [],
      positionSize: candidateSize,
      kellyFraction: kelly.fractionalKellyFraction,
      maxExposure: this.config.maxTotalExposureUsd,
      valueAtRisk: var95,
      checks,
    };
  }

  /** Update state after a trade is placed */
  recordTrade(sizeUsd: number, apiCostUsd: number = 0): void {
    this.state.portfolio.availableCash -= sizeUsd;
    this.state.tradesToday++;
    this.state.dailyApiCostUsd += apiCostUsd;
  }

  // Fix 3: track open positions so concurrent-position and exposure guards work
  openPosition(
    marketId: string,
    platform: Platform,
    direction: Direction,
    sizeUsd: number,
    entryPrice: number
  ): void {
    const pos: Position = {
      marketId,
      platform,
      direction,
      size: sizeUsd,
      entryPrice,
      currentPrice: entryPrice,
      unrealizedPnl: 0,
      openedAt: new Date(),
    };
    this.state.portfolio.openPositions.push(pos);
    logger.debug('RiskGuard: position opened', { marketId, sizeUsd, entryPrice });
  }

  closePosition(marketId: string, exitPrice: number): void {
    const idx = this.state.portfolio.openPositions.findIndex(
      (p) => p.marketId === marketId
    );
    if (idx === -1) return;

    const pos = this.state.portfolio.openPositions[idx]!;
    const pnl = (exitPrice - pos.entryPrice) * pos.size;
    this.state.portfolio.openPositions.splice(idx, 1);
    this.recordSettlement(pnl);
    logger.debug('RiskGuard: position closed', { marketId, exitPrice, pnl });
  }

  updatePositionPrice(marketId: string, currentPrice: number): void {
    const pos = this.state.portfolio.openPositions.find(
      (p) => p.marketId === marketId
    );
    if (!pos) return;
    pos.currentPrice = currentPrice;
    pos.unrealizedPnl = (currentPrice - pos.entryPrice) * pos.size;
  }

  /** Update state after a trade resolves */
  recordSettlement(pnl: number): void {
    this.state.portfolio.availableCash += pnl;
    this.state.portfolio.dailyPnl += pnl;
    this.state.portfolio.totalPnl += pnl;

    if (pnl < 0) this.state.dailyLossUsd += Math.abs(pnl);

    const peakBankroll = this.state.portfolio.totalBankroll;
    const currentBankroll = this.state.portfolio.availableCash;
    const drawdown = (peakBankroll - currentBankroll) / peakBankroll;
    this.state.portfolio.maxDrawdown = Math.max(this.state.portfolio.maxDrawdown, drawdown);
  }

  getPortfolioState(): PortfolioState {
    return { ...this.state.portfolio };
  }

  // ── Private Guards ────────────────────────────────────────────────────────

  private checkEdge(prediction: PredictionResult): GuardResult {
    const passed = Math.abs(prediction.edge) >= this.config.minEdge;
    return {
      passed,
      checkName: 'edge',
      value: Math.abs(prediction.edge),
      threshold: this.config.minEdge,
      reason: passed ? '' : `Edge ${(prediction.edge * 100).toFixed(2)}% < min ${(this.config.minEdge * 100).toFixed(2)}%`,
    };
  }

  private checkDailyLoss(): GuardResult {
    const passed = this.state.dailyLossUsd < this.config.maxDailyLossUsd;
    return {
      passed,
      checkName: 'daily_loss',
      value: this.state.dailyLossUsd,
      threshold: this.config.maxDailyLossUsd,
      reason: passed ? '' : `Daily loss $${this.state.dailyLossUsd.toFixed(2)} exceeds limit $${this.config.maxDailyLossUsd}`,
    };
  }

  private checkDrawdown(): GuardResult {
    const drawdown = this.state.portfolio.maxDrawdown;
    const passed = drawdown < this.config.maxDrawdownPct;
    return {
      passed,
      checkName: 'max_drawdown',
      value: drawdown,
      threshold: this.config.maxDrawdownPct,
      reason: passed ? '' : `Drawdown ${(drawdown * 100).toFixed(1)}% exceeds max ${(this.config.maxDrawdownPct * 100).toFixed(1)}%`,
    };
  }

  private checkExposure(): GuardResult {
    const currentExposure = this.state.portfolio.openPositions
      .reduce((s, p) => s + p.size, 0);
    const passed = currentExposure < this.config.maxTotalExposureUsd;
    return {
      passed,
      checkName: 'total_exposure',
      value: currentExposure,
      threshold: this.config.maxTotalExposureUsd,
      reason: passed ? '' : `Total exposure $${currentExposure.toFixed(2)} exceeds max $${this.config.maxTotalExposureUsd}`,
    };
  }

  private checkConcurrentPositions(): GuardResult {
    const count = this.state.portfolio.openPositions.length;
    const passed = count < this.config.maxConcurrentPositions;
    return {
      passed,
      checkName: 'concurrent_positions',
      value: count,
      threshold: this.config.maxConcurrentPositions,
      reason: passed ? '' : `${count} open positions >= max ${this.config.maxConcurrentPositions}`,
    };
  }

  private checkApiCost(): GuardResult {
    const passed = this.state.dailyApiCostUsd < this.config.maxDailyApiCostUsd;
    return {
      passed,
      checkName: 'api_cost',
      value: this.state.dailyApiCostUsd,
      threshold: this.config.maxDailyApiCostUsd,
      reason: passed ? '' : `Daily API cost $${this.state.dailyApiCostUsd.toFixed(2)} exceeds limit $${this.config.maxDailyApiCostUsd}`,
    };
  }

  // Fix 1: VaR check that actually blocks
  private checkVaR(var95: number): GuardResult {
    const limit = this.config.maxVaRUsd ?? this.config.maxDailyLossUsd * 0.95;
    const passed = var95 <= limit;
    return {
      passed,
      checkName: 'var_95',
      value: var95,
      threshold: limit,
      reason: passed ? '' : `VaR(95%) $${var95.toFixed(2)} exceeds limit $${limit.toFixed(2)}`,
    };
  }

  private failCheck(name: string, value: number, threshold: number, reason: string): RiskCheck {
    return { name, passed: false, value, threshold };
  }

  private reject(
    marketId: string,
    checks: RiskCheck[],
    positionSize: number,
    reasons: string[] = []
  ): RiskAssessment {
    return {
      marketId,
      approved: false,
      rejectionReasons: reasons,
      positionSize,
      kellyFraction: 0,
      maxExposure: this.config.maxTotalExposureUsd,
      valueAtRisk: 0,
      checks,
    };
  }

  private resetDailyStateIfNeeded(): void {
    const today = new Date().toISOString().split('T')[0]!;
    if (this.state.lastResetDate !== today) {
      this.state.dailyLossUsd = 0;
      this.state.dailyApiCostUsd = 0;
      this.state.tradesToday = 0;
      this.state.lastResetDate = today;
      this.state.portfolio.dailyPnl = 0;
      logger.info('RiskGuard: daily state reset');
    }
  }
}
