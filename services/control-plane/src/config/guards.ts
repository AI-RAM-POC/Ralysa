// Production guards shared by every entry point (F-002 design §3.8; SEC-F002-12). When
// env=production an entry point refuses to start on any of these. T07 adds the serve-specific
// guards (issuer, Graph URL, trust_proxy_cidrs, MFA claim) and the OpenBao seal-status check.
import type { CommonConfig } from './schema.js';

export function commonProductionRefusals(config: CommonConfig): string[] {
  if (config.env !== 'production') return [];
  const refusals: string[] = [];
  if (config.vault.auth.method === 'token')
    refusals.push('vault token auth is refused in production');
  if (config.vault.auth.method === 'approle' && !config.vault.allow_approle) {
    refusals.push('vault AppRole auth needs vault.allow_approle in production');
  }
  if (!config.vault.addr.startsWith('https://'))
    refusals.push('vault.addr must be https:// in production');
  if (!config.db.ssl) refusals.push('db.ssl must be true in production');
  return refusals;
}
