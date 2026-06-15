import { LearningReport, SignalReviewer } from './signal-review';
import { Notifier } from '../notify';

/** Format a learning report as a WhatsApp-friendly weekly summary. */
export function formatWeeklyReview(report: LearningReport, now: Date = new Date()): string {
  const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(1)}%`);
  return [
    `📊 Resumen semanal (${now.toISOString().slice(0, 10)})`,
    ``,
    `Posiciones: ${report.positions} · Win rate: ${pct(report.winRate)} · Retorno medio: ${pct(report.avgReturnPct)} · P&L US$${report.totalPnlUsd.toFixed(2)}`,
    ``,
    `Calibración (confianza → aciertos):`,
    ...report.calibration.map((b) => `  ${b.range}: n=${b.n} win=${pct(b.winRate)}`),
    ``,
    `Lecciones:`,
    ...report.lessons.map((l) => `• ${l}`),
    ``,
    `⚠️ Paper / sugerencias, no asesoría.`,
  ].join('\n');
}

/** Build the weekly review and send it via the notifier. Returns the message sent. */
export async function sendWeeklyReview(reviewer: SignalReviewer, notifier: Notifier): Promise<string> {
  const report = await reviewer.summarize();
  const message = formatWeeklyReview(report);
  await notifier.sendText(message);
  return message;
}
