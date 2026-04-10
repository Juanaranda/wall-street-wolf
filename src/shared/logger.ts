import winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
  return `[${ts}] ${level}: ${stack ?? message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    colorize(),
    logFormat
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'data/error.log',
      level: 'error',
      format: combine(errors({ stack: true }), timestamp(), winston.format.json()),
    }),
    new winston.transports.File({
      filename: 'data/combined.log',
      format: combine(timestamp(), winston.format.json()),
    }),
  ],
});
