// ─── src/monitoring/logger.ts ───
// Structured JSON logging with pino + correlation ID.

import pino from 'pino';

const LOG_LEVEL = process.env['LOG_LEVEL'] || 'info';

export const logger = pino({
  name: 'semantic-gateway',
  level: LOG_LEVEL,
  transport: process.env['APP_ENV'] === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
    : undefined,
  serializers: {
    err: pino.stdSerializers.err,
    req(req: { method: string; url: string; headers: Record<string, string> }) {
      return {
        method: req.method,
        url: req.url,
        // Redact auth headers
        headers: {
          ...req.headers,
          authorization: req.headers['authorization'] ? '[REDACTED]' : undefined,
          cookie: req.headers['cookie'] ? '[REDACTED]' : undefined,
        },
      };
    },
  },
  // PII masking — never log these fields
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.secret', '*.token'],
    censor: '[REDACTED]',
  },
});

/**
 * Create a child logger with correlation context.
 */
export function createContextLogger(correlationId: string, userId?: string) {
  return logger.child({
    correlation_id: correlationId,
    user_id: userId ?? 'anonymous',
  });
}

export type ContextLogger = ReturnType<typeof createContextLogger>;
