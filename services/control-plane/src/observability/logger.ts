// Minimal structured logger port: one JSON object per line. F-002-T07 replaces the sink with the
// service's pino instance and its redaction (§6.6). Callers pass ids and counts, never secrets,
// tokens or PII (AC-14).
import { scrubValue } from '../http/logging.js';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/**
 * A JSON-line logger for the one-shot entry points (migrate, sealer, audit-verify). Scrubbed like
 * the serve logger: message and fields pass through the same credential scrubber.
 */
export function createJsonLogger(
  write: (line: string) => void = (l) => process.stdout.write(l),
): Logger {
  const emit =
    (level: string) =>
    (msg: string, fields: LogFields = {}) => {
      const record = scrubValue({ ts: new Date().toISOString(), level, msg, ...fields });
      write(`${JSON.stringify(record)}\n`);
    };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
