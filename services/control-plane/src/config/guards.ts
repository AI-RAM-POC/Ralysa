// Production guards (F-002 design §3.8; SEC-F002-12, TC-F-002-34). When env=production an entry
// point refuses to start on any of these. Messages name the setting, never a value.
import { type CommonConfig, type ServeConfig, mfaClaimRequired } from './schema.js';

export function commonProductionRefusals(config: CommonConfig): string[] {
  if (config.env !== 'production') return [];
  const refusals: string[] = [];
  if (config.vault.auth.method === 'token') {
    refusals.push('vault token auth is refused in production');
  }
  if (config.vault.auth.method === 'approle' && !config.vault.allow_approle) {
    refusals.push('vault AppRole auth needs vault.allow_approle in production');
  }
  if (!config.vault.addr.startsWith('https://')) {
    refusals.push('vault.addr must be https:// in production');
  }
  if (!config.db.ssl) refusals.push('db.ssl must be true in production');
  return refusals;
}

const ENTRA_GRAPH = 'https://graph.microsoft.com';
const OPEN_CIDRS = new Set(['0.0.0.0/0', '::/0']);

/** The serve-only refusals (§3.8), on top of the common ones. */
export function serveProductionRefusals(config: ServeConfig): string[] {
  if (config.env !== 'production') return [];
  const refusals = commonProductionRefusals(config);
  if (!config.public_base_url.startsWith('https://')) {
    refusals.push('public_base_url must be https:// in production');
  }
  const issuer = `https://login.microsoftonline.com/${config.idp.tenant_id}/v2.0`;
  if (config.idp.issuer !== issuer) {
    refusals.push(
      'idp.issuer must be https://login.microsoftonline.com/<tenant_id>/v2.0 in production [AR-12]',
    );
  }
  if (config.idp.graph_base_url.replace(/\/+$/, '') !== ENTRA_GRAPH) {
    refusals.push(`idp.graph_base_url must be ${ENTRA_GRAPH} in production [AR-12]`);
  }
  if (config.trust_proxy_cidrs.some((cidr) => OPEN_CIDRS.has(cidr))) {
    refusals.push('trust_proxy_cidrs must not contain 0.0.0.0/0 or ::/0 in production');
  }
  if (!mfaClaimRequired(config) && config.access.mfa_claim_exception_ref === undefined) {
    refusals.push(
      'idp.require_mfa_claim=false needs access.mfa_claim_exception_ref in production (Q5)',
    );
  }
  return refusals;
}

export type SealStatusFetch = (
  url: string,
) => Promise<{ status: number; json(): Promise<unknown> }>;

/**
 * OpenBao `sys/seal-status` (unauthenticated): a dev server reports in-memory storage, which a
 * production entry point refuses (§3.8). An unreachable OpenBao is a refusal too (fail closed).
 */
export async function openBaoStorageRefusals(
  config: CommonConfig,
  fetchStatus: SealStatusFetch = (url) => fetch(url, { signal: AbortSignal.timeout(3000) }),
): Promise<string[]> {
  if (config.env !== 'production') return [];
  try {
    const response = await fetchStatus(
      `${config.vault.addr.replace(/\/+$/, '')}/v1/sys/seal-status`,
    );
    const body = (await response.json()) as { storage_type?: unknown; sealed?: unknown };
    if (body.storage_type === 'inmem') return ['OpenBao reports in-memory storage (a dev server)'];
    if (body.sealed === true) return ['OpenBao is sealed'];
    return [];
  } catch {
    return ['OpenBao seal-status is not reachable'];
  }
}
