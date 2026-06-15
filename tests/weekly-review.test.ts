import { formatWeeklyReview, sendWeeklyReview } from '../src/compound/weekly-review';
import { LearningReport } from '../src/compound/signal-review';
import { Notifier } from '../src/notify';

const report: LearningReport = {
  positions: 3,
  evaluated: 3,
  winRate: 2 / 3,
  avgReturnPct: 0.04,
  totalPnlUsd: 1.2,
  recommendationsOnRecord: 5,
  calibration: [
    { range: '0.50–0.70', n: 1, wins: 0, winRate: 0, avgReturnPct: -0.05 },
    { range: '0.85–1.00', n: 2, wins: 2, winRate: 1, avgReturnPct: 0.08 },
  ],
  lessons: ['Cartera: 3 posiciones, 2/3 en verde.'],
};

describe('formatWeeklyReview', () => {
  it('includes the key sections', () => {
    const msg = formatWeeklyReview(report, new Date('2026-06-07'));
    expect(msg).toContain('Resumen semanal (2026-06-07)');
    expect(msg).toContain('Win rate: 66.7%');
    expect(msg).toContain('Calibración');
    expect(msg).toContain('Posiciones: 3');
  });
});

describe('sendWeeklyReview', () => {
  it('summarizes and sends the message via the notifier', async () => {
    const reviewer = { summarize: jest.fn(async () => report) } as never;
    const notifier: Notifier & { sendText: jest.Mock } = {
      send: jest.fn(async () => {}),
      sendText: jest.fn(async () => {}),
    };
    const msg = await sendWeeklyReview(reviewer, notifier);
    expect(notifier.sendText).toHaveBeenCalledTimes(1);
    expect(notifier.sendText).toHaveBeenCalledWith(msg);
    expect(msg).toContain('Resumen semanal');
  });
});
