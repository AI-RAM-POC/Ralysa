// One pg Pool per database role an entry point may use (F-002 design §4.1; SEC-F002-02). The
// password comes from OpenBao at connect time (a function, so a rotated KV version is picked up
// by new connections); it is never in config or logs.
import pg from 'pg';

export interface DbEndpoint {
  host: string;
  port: number;
  database: string;
  ssl: boolean;
}

export interface DbCredential {
  user: string;
  password: string | (() => Promise<string>);
}

export interface PoolOptions {
  /** Shown in pg_stat_activity and the server log prefix (%a). */
  applicationName: string;
  max?: number;
}

export function createPool(
  endpoint: DbEndpoint,
  credential: DbCredential,
  options: PoolOptions,
): pg.Pool {
  return new pg.Pool({
    host: endpoint.host,
    port: endpoint.port,
    database: endpoint.database,
    user: credential.user,
    password: credential.password,
    ssl: endpoint.ssl ? { rejectUnauthorized: true } : false,
    application_name: options.applicationName,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5000,
  });
}
