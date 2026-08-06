import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: config.logLevel,
  transport: config.isProd
    ? undefined
    : {
        target: 'pino/file',
        options: { destination: 1 },
      },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      '*.password_hash',
      '*.accessToken',
      '*.authToken',
      'credentials',
      '*.credentials',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
