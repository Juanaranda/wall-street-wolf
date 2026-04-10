import { FailureCategory } from '../shared/types';

export interface LessonEntry {
  id: string;
  marketId: string;
  question: string;
  failureCategory: FailureCategory;
  lesson: string;
  marketPrice: number;
  predictedProbability: number;
  pnl: number;
  timestamp: Date;
}

export interface DailyConsolidationReport {
  date: string;
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  avgBrierScore: number;
  winRate: number;
  profitFactor: number;
  newLessons: LessonEntry[];
}

export interface PerformanceSummary {
  winRate: number;
  sharpeRatio: number;
  maxDrawdown: number;
  profitFactor: number;
  avgBrierScore: number;
  totalTrades: number;
  totalPnl: number;
}
