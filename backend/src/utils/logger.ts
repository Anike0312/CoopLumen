import winston from 'winston';

const SECRET_KEY = /authorization|cookie|token|secret|private.?key|signature|x-api-key/i;

export function redactSensitive(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
      .replace(/S[A-Z2-7]{55}/g, '[STELLAR_SECRET_REDACTED]');
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactSensitive(child, childKey),
      ])
    );
  }
  return value;
}

const redactFormat = winston.format((info) => redactSensitive(info) as winston.Logform.TransformableInfo);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: winston.format.combine(
    redactFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === 'production' ? winston.format.json() : winston.format.prettyPrint()
  ),
  transports: [new winston.transports.Console()],
  // Quiet under Jest so failures are not buried in request logs; set
  // LOG_LEVEL to see them while debugging a test.
  silent: process.env.NODE_ENV === 'test' && !process.env.LOG_LEVEL,
});
