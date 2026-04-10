import { TradingOrchestrator } from './orchestrator';
import { logger } from './shared/logger';

async function main(): Promise<void> {
  logger.info('Wall Street Wolf: prediction market trading bot starting...');

  const orchestrator = new TradingOrchestrator();

  // Graceful shutdown handlers
  process.on('SIGINT', () => {
    logger.info('Received SIGINT — shutting down gracefully');
    orchestrator.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM — shutting down gracefully');
    orchestrator.stop();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err });
    orchestrator.stop();
    process.exit(1);
  });

  try {
    await orchestrator.initialize();
    const intervalMs = parseInt(process.env['SCAN_INTERVAL_MS'] ?? '900000', 10);
    orchestrator.start(intervalMs);
    logger.info('Wall Street Wolf: bot is running. Press Ctrl+C to stop.');
  } catch (err) {
    logger.error('Failed to start bot', { err });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
