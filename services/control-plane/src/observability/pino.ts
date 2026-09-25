// One pino instance per serve process, carrying the §6.6 rules (redact, scrubber on objects AND
// message strings, serializers). Fastify uses it as its `loggerInstance`, and the Logger port
// used by the signing-key watcher, the audit spool and start-up is built on the same instance,
// so redaction applies to every line the process writes (T06-3, review of #25).
import { type Logger as Pino, pino } from 'pino';
import { loggerOptions } from '../http/logging.js';
import type { LogFields, Logger } from './logger.js';

export type PinoLogger = Pino;

export function createPinoLogger(
  level = 'info',
  stream?: { write(line: string): void },
): PinoLogger {
  return stream === undefined ? pino(loggerOptions(level)) : pino(loggerOptions(level), stream);
}

export function loggerFromPino(log: PinoLogger): Logger {
  const emit =
    (level: 'info' | 'warn' | 'error') =>
    (msg: string, fields: LogFields = {}) => {
      log[level]({ ...fields }, msg);
    };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}
