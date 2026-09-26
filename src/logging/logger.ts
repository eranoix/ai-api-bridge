import pino, { type Logger } from 'pino';
import { loadEnv } from '../config/env.js';

const env = loadEnv();

const redactPaths = [
  '*.headers.authorization',
  '*.headers["proxy-authorization"]',
  '*.headers.cookie',
  '*.headers["set-cookie"]',
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',

  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  '*.claudeAiOauth',
  '*.claudeAiOauth.accessToken',
  '*.claudeAiOauth.refreshToken',

  '*.api_key',
  '*.apiKey',
];

const isPretty = env.NODE_ENV !== 'production';

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  ...(isPretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

export function child(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
